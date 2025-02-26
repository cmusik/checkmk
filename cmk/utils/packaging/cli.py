#!/usr/bin/env python3
# Copyright (C) 2022 tribe29 GmbH - License: GNU General Public License v2
# This file is part of Checkmk (https://checkmk.com). It is subject to the terms and
# conditions defined in the file COPYING, which is part of this source code package.
import argparse
import json
import logging
import sys
from pathlib import Path
from typing import Callable

from cmk.utils import paths, tty
from cmk.utils import version as cmk_version
from cmk.utils.log import VERBOSE

from . import (
    create_mkp_object,
    disable,
    disable_outdated,
    get_classified_manifests,
    get_enabled_manifests,
    get_stored_manifests,
    get_unpackaged_files,
    install,
    PackageStore,
    release,
    update_active_packages,
)
from ._mkp import (
    extract_manifest,
    Manifest,
    manifest_template,
    PackagePart,
    read_manifest_optionally,
)
from ._parts import site_path, ui_title
from ._reporter import files_inventory
from ._type_defs import PackageException, PackageID, PackageName, PackageVersion


def _to_text(manifest: Manifest, summarize: bool = True) -> str:
    valid_until_text = manifest.version_usable_until or "No version limitation"
    files = "".join(
        "\n  %s%s" % (ui_title(part), "".join(f"\n    {f}" for f in fs))
        for part, fs in manifest.files.items()
    )
    return (
        f"Name:                          {manifest.name}\n"
        f"Version:                       {manifest.version}\n"
        f"Packaged on Checkmk Version:   {manifest.version_packaged}\n"
        f"Required Checkmk Version:      {manifest.version_min_required}\n"
        f"Valid until Checkmk version:   {valid_until_text}\n"
        f"Title:                         {manifest.title}\n"
        f"Author:                        {manifest.author}\n"
        f"Download-URL:                  {manifest.download_url}\n"
        f"Files:                         {files}\n"
        f"Description:\n  {manifest.description}\n"
    )


def _args_find(
    subparser: argparse.ArgumentParser,
) -> None:
    subparser.add_argument(
        "-a",
        "--all",
        action="store_true",
        help="Include packaged files in report",
    )
    subparser.add_argument(
        "--json",
        action="store_true",
        help="format output as json",
    )


def _command_find(args: argparse.Namespace, logger: logging.Logger) -> int:
    """Show information about local files"""

    files = files_inventory(paths.local_root)

    if not args.all:
        files = [f for f in files if not f["package"]]

    if args.json:
        sys.stdout.write(f"{json.dumps(files, indent='  ')}\n")
        return 0

    tty.print_table(
        ["File", "Package", "Version", "Part", "Mode"],
        ["", "", "", "", ""],
        [[f["file"], f["package"], f["version"], f["part_title"], f["mode"]] for f in files],
    )
    return 0


def _args_inspect(
    subparser: argparse.ArgumentParser,
) -> None:
    subparser.add_argument("--json", action="store_true", help="format output as json")
    subparser.add_argument("file", type=Path, help="Path to an MKP file")


def _command_inspect(args: argparse.Namespace, _logger: logging.Logger) -> int:
    """Show manifest of an MKP file"""
    file_path: Path = args.file
    try:
        file_content = file_path.read_bytes()
    except OSError as exc:
        raise PackageException from exc

    manifest = extract_manifest(file_content)

    sys.stdout.write(f"{manifest.json() if args.json else _to_text(manifest)}\n")
    return 0


def _args_show_all(
    subparser: argparse.ArgumentParser,
) -> None:
    subparser.add_argument("--json", action="store_true", help="format output as json")


def _command_show_all(args: argparse.Namespace, _logger: logging.Logger) -> int:
    """Show all manifests"""
    stored_manifests = get_stored_manifests(PackageStore())

    if args.json:
        sys.stdout.write(f"{stored_manifests.json()}\n")
        return 0

    # I don't think this is very useful, but we include it for consistency.
    sys.stdout.write("Local extension packages\n========================\n\n")
    sys.stdout.write("".join(f"{_to_text(m)}\n" for m in stored_manifests.local))
    sys.stdout.write("Shipped extension packages\n==========================\n\n")
    sys.stdout.write("".join(f"{_to_text(m)}\n" for m in stored_manifests.shipped))
    return 0


def _args_show(
    subparser: argparse.ArgumentParser,
) -> None:
    subparser.add_argument("--json", action="store_true", help="format output as json")
    _args_package_id(subparser)


def _command_show(args: argparse.Namespace, _logger: logging.Logger) -> int:
    """Show package manifest"""
    manifest = extract_manifest(
        PackageStore()
        .get_existing_package_path(_get_package_id(args.name, args.version))
        .read_bytes()
    )
    sys.stdout.write(f"{manifest.json() if args.json else _to_text(manifest)}\n")
    return 0


def _command_files(args: argparse.Namespace, _logger: logging.Logger) -> int:
    """Show all files beloning to a package"""
    manifest = extract_manifest(
        PackageStore()
        .get_existing_package_path(_get_package_id(args.name, args.version))
        .read_bytes()
    )
    sys.stdout.write(
        "".join(
            f"{site_path(part) / rel_path}\n"
            for part, rel_paths in manifest.files.items()
            for rel_path in rel_paths
        )
    )
    return 0


def _args_list(
    subparser: argparse.ArgumentParser,
) -> None:
    subparser.add_argument("--json", action="store_true", help="format output as json")


def _command_list(args: argparse.Namespace, logger: logging.Logger) -> int:

    classified_manifests = get_classified_manifests(PackageStore(), logger)

    if args.json:
        sys.stdout.write(f"{classified_manifests.json()}\n")
        return 0

    enabled_ids = {m.id for m in classified_manifests.enabled}
    disabled = [
        m
        for m in [
            *classified_manifests.stored.local,
            *classified_manifests.stored.shipped,
        ]
        if m.id not in enabled_ids
    ]
    tty.print_table(
        ["Name", "Version", "Title", "Author", "Req. Version", "Until Version", "Files", "State"],
        ["", "", "", "", "", "", "", ""],
        [
            *(_row(m, "Enabled (active on this site)") for m in classified_manifests.installed),
            *(_row(m, "Enabled (inactive on this site)") for m in classified_manifests.inactive),
            *(_row(m, "Disabled") for m in disabled),
        ],
    )
    return 0


def _row(manifest: Manifest, state: str) -> list[str]:
    return [
        str(manifest.name),
        str(manifest.version),
        str(manifest.title),
        str(manifest.author),
        str(manifest.version_min_required),
        str(manifest.version_usable_until),
        str(sum(len(f) for f in manifest.files.values())),
        state,
    ]


def _args_store(
    subparser: argparse.ArgumentParser,
) -> None:
    subparser.add_argument("file", type=Path, help="Path to an MKP file")


def _command_store(args: argparse.Namespace, _logger: logging.Logger) -> int:
    """Add an MKP to the collection of managed MKPs"""
    file_path: Path = args.file
    try:
        file_content = file_path.read_bytes()
    except OSError as exc:
        raise PackageException from exc

    manifest = PackageStore().store(file_content)

    sys.stdout.write(f"{manifest.name} {manifest.version}\n")
    return 0


def _args_release(
    subparser: argparse.ArgumentParser,
) -> None:
    subparser.add_argument(
        "name",
        type=PackageName,
        help="The packages name",
    )


def _command_release(args: argparse.Namespace, logger: logging.Logger) -> int:
    """Release package

    This command removes the package, and leaves its contained files as unpackaged files behind.
    """
    release(args.name, logger)
    return 0


def _command_remove(args: argparse.Namespace, logger: logging.Logger) -> int:
    """Remove a package from the site"""
    package_id = _get_package_id(args.name, args.version)
    if package_id in get_enabled_manifests():
        raise PackageException("This package is enabled! Please disable it first.")

    logger.log(VERBOSE, "Removing package %s...", package_id.name)
    PackageStore().remove(package_id)
    logger.log(VERBOSE, "Successfully removed package %s.", package_id.name)
    return 0


def _command_disable_outdated(_args: argparse.Namespace, _logger: logging.Logger) -> int:
    """Disable MKP packages that are declared to be outdated with the new version

    Since 1.6 there is the option version.usable_until available in MKP packages.
    For all installed packages, this command compares that version with the Checkmk version.
    In case it is outdated, the package is disabled.
    """
    disable_outdated()
    return 0


def _command_update_active(_args: argparse.Namespace, logger: logging.Logger) -> int:
    """Disable MKP packages that are not suitable for this version, and enable others

    Packages can declare their minimum or maximum required Checkmk versions.
    Also packages can collide with one another or fail to load for other reasons.

    This command disables all packages that are not applicable, and then enables the ones that are.
    """
    update_active_packages(logger)
    return 0


def _args_package_id(
    subparser: argparse.ArgumentParser,
) -> None:
    subparser.add_argument(
        "name",
        type=PackageName,
        help="The package name",
    )
    subparser.add_argument(
        "version",
        type=PackageVersion,
        default=None,
        nargs="?",
        help="The package version. If only one package by the given name is applicable, the version can be omitted.",
    )


def _command_enable(args: argparse.Namespace, _logger: logging.Logger) -> int:
    """Enable previously disabled package NAME"""
    install(PackageStore(), _get_package_id(args.name, args.version))
    return 0


def _command_disable(args: argparse.Namespace, _logger: logging.Logger) -> int:
    """Disable an enabled package"""
    disable(args.name, args.version)
    return 0


def _args_template(
    subparser: argparse.ArgumentParser,
) -> None:
    subparser.add_argument(
        "name",
        type=PackageName,
        help="The packages name",
    )


def _command_template(args: argparse.Namespace, _logger: logging.Logger) -> int:
    """Create a template of a package manifest"""

    unpackaged = get_unpackaged_files()

    package = manifest_template(
        name=args.name,
        version_packaged=cmk_version.__version__,
        files={part: files_ for part in PackagePart if (files_ := unpackaged.get(part))},
    )

    temp_file = Path(paths.tmp_dir, f"{args.name}.manifest.temp")
    temp_file.write_text(package.file_content())
    sys.stdout.write(
        "Created '{temp_file}'.\n"
        "You may now edit it.\n"
        "Create the package using `mkp package {temp_file}`.\n"
    )
    return 0


def _args_package(
    subparser: argparse.ArgumentParser,
) -> None:
    subparser.add_argument(
        "manifest_file",
        type=Path,
        help="The path to an package manifest file",
    )


def _command_package(args: argparse.Namespace, logger: logging.Logger) -> int:
    if (package := read_manifest_optionally(args.manifest_file, logger=logger)) is None:
        return 1

    try:
        _ = PackageVersion.parse_semver(package.version)
    except ValueError as exc:
        sys.stderr.write(f"{exc}\n")
        return 1

    store = PackageStore()
    try:
        manifest = store.store(create_mkp_object(package))
        install(store, manifest.id)
    except PackageException as exc:
        sys.stderr.write(f"{exc}\n")
        return 1

    logger.log(VERBOSE, "Successfully created %s %s", manifest.name, manifest.version)
    return 0


def _get_package_id(
    name: PackageName,
    version: PackageVersion | None,
) -> PackageID:
    if version is not None:
        return PackageID(name=name, version=version)

    stored_packages = get_stored_manifests(PackageStore())
    match [
        *(p for p in stored_packages.local if p.name == name),
        *(p for p in stored_packages.shipped if p.name == name),
    ]:
        case ():
            raise PackageException(f"No such package: {name}")
        case (single_match,):
            return single_match.id
        case multiple_matches:
            raise PackageException(
                f"Please specify version ({', '.join(m.version for m in multiple_matches)})"
            )


def _parse_arguments(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="mkp",
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--debug", "-d", action="store_true")
    subparsers = parser.add_subparsers(required=True)

    _add_command(subparsers, "find", _args_find, _command_find)
    _add_command(subparsers, "inspect", _args_inspect, _command_inspect)
    _add_command(subparsers, "show-all", _args_show_all, _command_show_all)
    _add_command(subparsers, "show", _args_show, _command_show)
    _add_command(subparsers, "files", _args_package_id, _command_files)
    _add_command(subparsers, "list", _args_list, _command_list)
    _add_command(subparsers, "store", _args_store, _command_store)
    _add_command(subparsers, "release", _args_release, _command_release)
    _add_command(subparsers, "remove", _args_package_id, _command_remove)
    _add_command(subparsers, "enable", _args_package_id, _command_enable)
    _add_command(subparsers, "disable", _args_package_id, _command_disable)
    _add_command(subparsers, "template", _args_template, _command_template)
    _add_command(subparsers, "package", _args_package, _command_package)
    _add_command(subparsers, "disable-outdated", _no_args, _command_disable_outdated)
    _add_command(subparsers, "update-active", _no_args, _command_update_active)

    return parser.parse_args(argv)


def _no_args(subparser: argparse.ArgumentParser) -> None:
    """This command has no arguments"""


def _add_command(
    subparsers: argparse._SubParsersAction,
    cmd: str,
    args_adder: Callable[[argparse.ArgumentParser], None],
    handler: Callable[[argparse.Namespace, logging.Logger], int],
) -> None:
    subparser = subparsers.add_parser(cmd, help=handler.__doc__)
    args_adder(subparser)
    subparser.set_defaults(handler=handler)


def main(argv: list[str], logger: logging.Logger) -> int:
    args = _parse_arguments(argv)
    try:
        return args.handler(args, logger)
    except PackageException as exc:
        if args.debug:
            raise
        sys.stderr.write(f"{exc}\n")
        return 1
