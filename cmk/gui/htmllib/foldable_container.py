#!/usr/bin/env python3
# Copyright (C) 2021 tribe29 GmbH - License: GNU General Public License v2
# This file is part of Checkmk (https://checkmk.com). It is subject to the terms and
# conditions defined in the file COPYING, which is part of this source code package.
"""Foldable containers for pages"""

import json
from collections.abc import Iterator
from contextlib import contextmanager

from cmk.gui.htmllib.html import html
from cmk.gui.logged_in import user
from cmk.gui.utils.html import HTML
from cmk.gui.utils.theme import theme

from .tag_rendering import HTMLContent

__all__ = [
    "foldable_container",
    "foldable_container_id",
    "foldable_container_img_id",
    "foldable_container_onclick",
]


@contextmanager
def foldable_container(
    *,
    treename: str,
    id_: str,
    isopen: bool,
    title: HTMLContent,
    indent: str | None | bool = True,
    icon: str | None = None,
    fetch_url: str | None = None,
    title_url: str | None = None,
    title_target: str | None = None,
    padding: int = 15,
    save_state: bool = True,
) -> Iterator[bool]:
    isopen = user.get_tree_state(treename, id_, isopen)
    onclick = foldable_container_onclick(treename, id_, fetch_url, save_state)
    img_id = foldable_container_img_id(treename, id_)
    container_id = foldable_container_id(treename, id_)

    html.open_div(class_=["foldable", "open" if isopen else "closed"])
    html.open_div(class_="foldable_header", onclick=None if title_url else onclick)

    if isinstance(title, HTML):  # custom HTML code
        html.write_text(title)

    else:
        html.open_b(class_=["treeangle", "title"])

        if title_url:
            html.a(title, href=title_url, target=title_target)
        else:
            html.write_text(title)
        html.close_b()

    if icon:
        html.img(
            id_=img_id,
            # Although foldable_sidebar is given via the argument icon it should not be displayed as big as an icon.
            class_=(
                ["treeangle", "title"]
                + (["icon"] if icon != "foldable_sidebar" else [])
                + ["open" if isopen else "closed"]
            ),
            src=theme.detect_icon_path(icon, "icon_"),
            onclick=onclick if title_url else None,
        )
    else:
        html.img(
            id_=img_id,
            class_=["treeangle", "open" if isopen else "closed"],
            src=theme.url("images/tree_closed.svg"),
            onclick=onclick if title_url else None,
        )

    html.close_div()

    indent_style = "padding-left: %dpx; " % (padding if indent else 0)
    if indent == "form":
        html.close_td()
        html.close_tr()
        html.close_table()
        indent_style += "margin: 0; "
    html.open_ul(
        id_=container_id, class_=["treeangle", "open" if isopen else "closed"], style=indent_style
    )

    yield isopen

    html.close_ul()
    html.close_div()


def foldable_container_onclick(
    treename: str,
    id_: str,
    fetch_url: str | None,
    save_state: bool = True,
) -> str:
    return "cmk.foldable_container.toggle({}, {}, {}, {})".format(
        json.dumps(treename),
        json.dumps(id_),
        json.dumps(fetch_url if fetch_url else ""),
        json.dumps(save_state),
    )


def foldable_container_img_id(treename: str, id_: str) -> str:
    return f"treeimg.{treename}.{id_}"


def foldable_container_id(treename: str, id_: str) -> str:
    return f"tree.{treename}.{id_}"
