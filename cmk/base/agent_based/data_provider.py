#!/usr/bin/env python3
# Copyright (C) 2019 tribe29 GmbH - License: GNU General Public License v2
# This file is part of Checkmk (https://checkmk.com). It is subject to the terms and
# conditions defined in the file COPYING, which is part of this source code package.

from __future__ import annotations

import itertools
import logging
from collections.abc import Iterable, Iterator, Mapping, Sequence
from typing import Any, Final, NamedTuple

import cmk.utils.piggyback
import cmk.utils.tty as tty
from cmk.utils.cpu_tracking import Snapshot
from cmk.utils.exceptions import OnError
from cmk.utils.log import console
from cmk.utils.type_defs import (
    AgentRawData,
    HostAddress,
    HostName,
    ParsedSectionName,
    result,
    SectionName,
)

from cmk.snmplib.type_defs import SNMPRawData

from cmk.fetchers import fetch_all, Mode, SourceInfo, SourceType
from cmk.fetchers.filecache import FileCacheOptions, MaxAge

from cmk.checkers import HostKey, parse_raw_data
from cmk.checkers.host_sections import HostSections
from cmk.checkers.type_defs import NO_SELECTION, SectionNameCollection

import cmk.base.api.agent_based.register as agent_based_register
import cmk.base.config as config
from cmk.base.api.agent_based.type_defs import SectionPlugin
from cmk.base.config import ConfigCache
from cmk.base.crash_reporting import create_section_crash_dump
from cmk.base.sources import make_parser, make_sources

_CacheInfo = tuple[int, int]

ParsedSectionContent = object  # the parse function may return *anything*.


class ParsingResult(NamedTuple):
    data: ParsedSectionContent
    cache_info: _CacheInfo | None


class ResolvedResult(NamedTuple):
    parsed: ParsingResult
    section: SectionPlugin


class SectionsParser:
    """Call the sections parse function and return the parsing result."""

    def __init__(
        self,
        host_sections: HostSections,
        host_name: HostName,
    ) -> None:
        super().__init__()
        self._host_sections = host_sections
        self._parsing_errors: list[str] = []
        self._memoized_results: dict[SectionName, ParsingResult | None] = {}
        self._host_name = host_name

    def __repr__(self) -> str:
        return "{}(host_sections={!r}, host_name={!r})".format(
            type(self).__name__,
            self._host_sections,
            self._host_name,
        )

    @property
    def parsing_errors(self) -> Sequence[str]:
        return self._parsing_errors

    def parse(self, section: SectionPlugin) -> ParsingResult | None:
        if section.name in self._memoized_results:
            return self._memoized_results[section.name]

        return self._memoized_results.setdefault(
            section.name,
            None
            if (parsed := self._parse_raw_data(section)) is None
            else ParsingResult(
                data=parsed,
                cache_info=self._get_cache_info(section.name),
            ),
        )

    def disable(self, raw_section_names: Iterable[SectionName]) -> None:
        for section_name in raw_section_names:
            self._memoized_results[section_name] = None

    def _parse_raw_data(self, section: SectionPlugin) -> Any:  # yes *ANY*
        try:
            raw_data = self._host_sections.sections[section.name]
        except KeyError:
            return None

        try:
            return section.parse_function(list(raw_data))
        except Exception:
            if cmk.utils.debug.enabled():
                raise
            self._parsing_errors.append(
                create_section_crash_dump(
                    operation="parsing",
                    section_name=section.name,
                    section_content=raw_data,
                    host_name=self._host_name,
                    rtc_package=None,
                )
            )
            return None

    def _get_cache_info(self, section_name: SectionName) -> _CacheInfo | None:
        return self._host_sections.cache_info.get(section_name)


class ParsedSectionsResolver:
    """Find the desired parsed data by ParsedSectionName

    This class resolves ParsedSectionNames while respecting supersedes.
    """

    def __init__(
        self,
        *,
        section_plugins: Sequence[SectionPlugin],
    ) -> None:
        self._section_plugins = section_plugins
        self._memoized_results: dict[ParsedSectionName, ResolvedResult | None] = {}
        self._superseders = self._init_superseders()
        self._producers = self._init_producers()

    def __repr__(self) -> str:
        return f"{self.__class__.__name__}(section_plugins={self._section_plugins})"

    def _init_superseders(self) -> Mapping[SectionName, Sequence[SectionPlugin]]:
        superseders: dict[SectionName, list[SectionPlugin]] = {}
        for section in self._section_plugins:
            for superseded in section.supersedes:
                superseders.setdefault(superseded, []).append(section)
        return superseders

    def _init_producers(self) -> Mapping[ParsedSectionName, Sequence[SectionPlugin]]:
        producers: dict[ParsedSectionName, list[SectionPlugin]] = {}
        for section in self._section_plugins:
            producers.setdefault(section.parsed_section_name, []).append(section)
        return producers

    def resolve(
        self,
        parser: SectionsParser,
        parsed_section_name: ParsedSectionName,
    ) -> ResolvedResult | None:
        if parsed_section_name in self._memoized_results:
            return self._memoized_results[parsed_section_name]

        # try all producers. If there can be multiple, supersedes should come into play
        for producer in self._producers.get(parsed_section_name, ()):
            # Before we can parse the section, we must parse all potential superseders.
            # Registration validates against indirect supersedings, no need to recurse
            for superseder in self._superseders.get(producer.name, ()):
                if parser.parse(superseder) is not None:
                    parser.disable(superseder.supersedes)

            if (parsing_result := parser.parse(producer)) is not None:
                return self._memoized_results.setdefault(
                    parsed_section_name,
                    ResolvedResult(
                        parsed=parsing_result,
                        section=producer,
                    ),
                )

        return self._memoized_results.setdefault(parsed_section_name, None)

    def resolve_all(self, parser: SectionsParser) -> Iterator[ResolvedResult]:
        return iter(
            res
            for psn in {section.parsed_section_name for section in self._section_plugins}
            if (res := self.resolve(parser, psn)) is not None
        )


class ParsedSectionsBroker:
    """Object for aggregating, parsing and disributing the sections

    An instance of this class allocates all raw sections of a given host or cluster and
    hands over the parsed sections and caching information after considering features like
    'parsed_section_name' and 'supersedes' to all plugin functions that require this kind
    of data (inventory, discovery, checking, host_labels).
    """

    def __init__(
        self,
        providers: Mapping[HostKey, tuple[ParsedSectionsResolver, SectionsParser]],
    ) -> None:
        super().__init__()
        self._providers: Final = providers

    def __repr__(self) -> str:
        return f"{self.__class__.__name__}(providers={self._providers!r})"

    def get_cache_info(
        self,
        parsed_section_names: list[ParsedSectionName],
    ) -> _CacheInfo | None:
        # TODO: should't the host key be provided here?
        """Aggregate information about the age of the data in the agent sections

        In order to determine the caching info for a parsed section we must in fact
        parse it, because otherwise we cannot know from which raw section to take
        the caching info.
        But fear not, the parsing itself is cached.
        """
        cache_infos = [
            resolved.parsed.cache_info
            for resolved in (
                resolver.resolve(parser, parsed_section_name)
                for resolver, parser in self._providers.values()
                for parsed_section_name in parsed_section_names
            )
            if resolved is not None and resolved.parsed.cache_info is not None
        ]
        return (
            (
                min(ats for ats, _intervals in cache_infos),
                max(intervals for _ats, intervals in cache_infos),
            )
            if cache_infos
            else None
        )

    def get_parsed_section(
        self,
        host_key: HostKey,
        parsed_section_name: ParsedSectionName,
    ) -> ParsedSectionContent | None:
        try:
            resolver, parser = self._providers[host_key]
        except KeyError:
            return None

        return (
            None
            if (resolved := resolver.resolve(parser, parsed_section_name)) is None
            else resolved.parsed.data
        )

    def filter_available(
        self,
        parsed_section_names: Iterable[ParsedSectionName],
        source_type: SourceType,
    ) -> set[ParsedSectionName]:
        return {
            parsed_section_name
            for host_key, (resolver, parser) in self._providers.items()
            for parsed_section_name in parsed_section_names
            if (
                host_key.source_type is source_type
                and resolver.resolve(parser, parsed_section_name) is not None
            )
        }

    def all_parsing_results(self, host_key: HostKey) -> Iterable[ResolvedResult]:
        try:
            resolver, parser = self._providers[host_key]
        except KeyError:
            return ()

        return sorted(resolver.resolve_all(parser), key=lambda r: r.section.name)

    def parsing_errors(self) -> Sequence[str]:
        return sum(
            (list(parser.parsing_errors) for _, parser in self._providers.values()),
            start=[],
        )


class ConfiguredParser:
    def __init__(
        self,
        config_cache: ConfigCache,
        *,
        selected_sections: SectionNameCollection,
        keep_outdated: bool,
        logger: logging.Logger,
    ) -> None:
        self.config_cache: Final = config_cache
        self.selected_sections: Final = selected_sections
        self.keep_outdated: Final = keep_outdated
        self.logger: Final = logger

    def __call__(
        self,
        fetched: Iterable[tuple[SourceInfo, result.Result[AgentRawData | SNMPRawData, Exception]]],
    ) -> Sequence[tuple[SourceInfo, result.Result[HostSections, Exception]]]:
        """Parse fetched data."""
        console.vverbose("%s+%s %s\n", tty.yellow, tty.normal, "Parse fetcher results".upper())
        output: list[tuple[SourceInfo, result.Result[HostSections, Exception]]] = []
        # Special agents can produce data for the same check_plugin_name on the same host, in this case
        # the section lines need to be extended
        for source, raw_data in fetched:
            source_result = parse_raw_data(
                make_parser(
                    self.config_cache,
                    source,
                    checking_sections=self.config_cache.make_checking_sections(
                        source.hostname, selected_sections=NO_SELECTION
                    ),
                    keep_outdated=self.keep_outdated,
                    logger=self.logger,
                ),
                raw_data,
                selection=self.selected_sections,
            )
            output.append((source, source_result))
        return output


def filter_out_errors(
    host_sections: Iterable[tuple[SourceInfo, result.Result[HostSections, Exception]]]
) -> Mapping[HostKey, HostSections]:
    output: dict[HostKey, HostSections] = {}
    for source, host_section in host_sections:
        host_key = HostKey(source.hostname, source.source_type)
        console.vverbose(f"  {host_key!s}")
        output.setdefault(host_key, HostSections())
        if host_section.is_ok():
            console.vverbose(
                "  -> Add sections: %s\n"
                % sorted([str(s) for s in host_section.ok.sections.keys()])
            )
            output[host_key] += host_section.ok
        else:
            console.vverbose("  -> Not adding sections: %s\n" % host_section.error)
    return output


class ConfiguredFetcher:
    def __init__(
        self,
        config_cache: ConfigCache,
        *,
        # alphabetically sorted
        file_cache_options: FileCacheOptions,
        force_snmp_cache_refresh: bool,
        mode: Mode,
        on_error: OnError,
        selected_sections: SectionNameCollection,
        simulation_mode: bool,
        max_cachefile_age: MaxAge | None = None,
    ) -> None:
        self.config_cache: Final = config_cache
        self.file_cache_options: Final = file_cache_options
        self.force_snmp_cache_refresh: Final = force_snmp_cache_refresh
        self.mode: Final = mode
        self.on_error: Final = on_error
        self.selected_sections: Final = selected_sections
        self.simulation_mode: Final = simulation_mode
        self.max_cachefile_age: Final = max_cachefile_age

    def __call__(
        self, host_name: HostName, *, ip_address: HostAddress | None
    ) -> Sequence[
        tuple[SourceInfo, result.Result[AgentRawData | SNMPRawData, Exception], Snapshot]
    ]:
        nodes = self.config_cache.nodes_of(host_name)
        if nodes is None:
            # In case of keepalive we always have an ipaddress (can be 0.0.0.0 or :: when
            # address is unknown). When called as non keepalive ipaddress may be None or
            # is already an address (2nd argument)
            hosts = [
                (host_name, ip_address or config.lookup_ip_address(self.config_cache, host_name))
            ]
        else:
            hosts = [(node, config.lookup_ip_address(self.config_cache, node)) for node in nodes]

        return fetch_all(
            itertools.chain.from_iterable(
                make_sources(
                    host_name_,
                    ip_address_,
                    config_cache=self.config_cache,
                    force_snmp_cache_refresh=(
                        self.force_snmp_cache_refresh if nodes is None else False
                    ),
                    selected_sections=self.selected_sections if nodes is None else NO_SELECTION,
                    on_scan_error=self.on_error if nodes is None else OnError.RAISE,
                    simulation_mode=self.simulation_mode,
                    file_cache_options=self.file_cache_options,
                    file_cache_max_age=self.max_cachefile_age
                    or self.config_cache.max_cachefile_age(host_name),
                )
                for host_name_, ip_address_ in hosts
            ),
            mode=self.mode,
        )


def store_piggybacked_sections(collected_host_sections: Mapping[HostKey, HostSections]) -> None:
    for host_key, host_sections in collected_host_sections.items():
        # Store piggyback information received from all sources of this host. This
        # also implies a removal of piggyback files received during previous calls.
        if host_key.source_type is SourceType.MANAGEMENT:
            # management board (SNMP or IPMI) does not support piggybacking
            continue

        cmk.utils.piggyback.store_piggyback_raw_data(
            host_key.hostname, host_sections.piggybacked_raw_data
        )


def make_broker(
    host_sections: Mapping[HostKey, HostSections],
) -> ParsedSectionsBroker:
    return ParsedSectionsBroker(
        {
            host_key: (
                ParsedSectionsResolver(
                    section_plugins=[
                        agent_based_register.get_section_plugin(section_name)
                        for section_name in host_sections.sections
                    ],
                ),
                SectionsParser(host_sections=host_sections, host_name=host_key.hostname),
            )
            for host_key, host_sections in host_sections.items()
        }
    )
