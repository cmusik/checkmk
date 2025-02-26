// Copyright (C) 2019 tribe29 GmbH - License: GNU General Public License v2
// This file is part of Checkmk (https://checkmk.com). It is subject to the terms and
// conditions defined in the file COPYING, which is part of this source code package.

import * as d3 from "d3";
import * as d3_flextree from "d3-flextree";
import {Coords, NodevisNode, RectangleWithCoords} from "nodevis/type_defs";
import {
    AbstractLayoutStyle,
    layout_style_class_registry,
    NodeForce,
    StyleOptionDefinition,
} from "nodevis/layout_utils";
import {get_bounding_rect_of_rotated_vertices, log} from "nodevis/utils";
import {
    compute_node_position,
    compute_node_positions_from_list_of_nodes,
} from "nodevis/layout";

//#.
//#   .-Force--------------------------------------------------------------.
//#   |                       _____                                        |
//#   |                      |  ___|__  _ __ ___ ___                       |
//#   |                      | |_ / _ \| '__/ __/ _ \                      |
//#   |                      |  _| (_) | | | (_|  __/                      |
//#   |                      |_|  \___/|_|  \___\___|                      |
//#   |                                                                    |
//#   +--------------------------------------------------------------------+

export class LayoutStyleForce extends AbstractLayoutStyle {
    static class_name = "force";
    static description = "Free-Floating style";

    type() {
        return "force";
    }

    style_color(): string {
        return "#9c9c9c";
    }

    compute_id(node): string {
        return this.type() + "_" + node.data.id;
    }

    id(): string {
        return this.compute_id(this.style_root_node);
    }

    force_style_translation(): void {
        this._world.force_simulation.setup_forces();
    }

    get_style_options(): StyleOptionDefinition[] {
        return [
            {
                id: "center_force",
                values: {default: 5, min: -20, max: 100},
                option_type: "range",
                text: "Center force strength",
                value: this.style_config.options.center_force,
            },
            //                {id: "maxdistance", values: {default: 800, min: 10, max: 2000}, option_type:"range",
            //                 text: "Max force distance", value: this.style_config.options.maxdistance},
            {
                id: "force_node",
                values: {default: -300, min: -1000, max: 50},
                option_type: "range",
                text: "Repulsion force leaf",
                value: this.style_config.options.force_node,
            },
            {
                id: "force_aggregator",
                values: {default: -300, min: -1000, max: 50},
                option_type: "range",
                text: "Repulsion force branch",
                value: this.style_config.options.force_aggregator,
            },
            {
                id: "link_force_node",
                values: {default: 30, min: -10, max: 300},
                option_type: "range",
                text: "Link distance leaf",
                value: this.style_config.options.link_force_node,
            },
            {
                id: "link_force_aggregator",
                values: {default: 30, min: -10, max: 300},
                option_type: "range",
                text: "Link distance branches",
                value: this.style_config.options.link_force_aggregator,
            },
            {
                id: "link_strength",
                values: {default: 30, min: 0, max: 200},
                option_type: "range",
                text: "Link strength",
                value: this.style_config.options.link_strength,
            },
            {
                id: "collision_force_node",
                values: {default: 15, min: 0, max: 150},
                option_type: "range",
                text: "Collision box leaf",
                value: this.style_config.options.collision_force_node,
            },
            {
                id: "collision_force_aggregator",
                values: {default: 15, min: 0, max: 150},
                option_type: "range",
                text: "Collision box branch",
                value: this.style_config.options.collision_force_aggregator,
            },
        ];
    }
}

//#.
//#   .-Hierarchy----------------------------------------------------------.
//#   |             _   _ _                         _                      |
//#   |            | | | (_) ___ _ __ __ _ _ __ ___| |__  _   _            |
//#   |            | |_| | |/ _ \ '__/ _` | '__/ __| '_ \| | | |           |
//#   |            |  _  | |  __/ | | (_| | | | (__| | | | |_| |           |
//#   |            |_| |_|_|\___|_|  \__,_|_|  \___|_| |_|\__, |           |
//#   |                                                   |___/            |
//#   +--------------------------------------------------------------------+

export class LayoutStyleHierarchyBase extends AbstractLayoutStyle {
    unrotated_vertices: Coords[] = [];
    // TODO: split info
    drag_start_info = {
        start_coords: [0, 0],
        delta: {x: 0, y: 0},
        options: {
            degree: 0,
            radius: 0,
            rotation: 0,
            height: 0,
            node_size: 0,
            layer_height: 0,
        },
    };
    max_depth = 1;
    _layer_count = 0;

    positioning_weight(): number {
        return 10 + this.style_root_node.depth;
    }

    remove(): void {
        this.get_div_selection().remove();
        AbstractLayoutStyle.prototype.remove.call(this);
        this._cleanup_style_node_positioning();
    }

    _cleanup_style_node_positioning(): void {
        if (this.style_root_node) {
            this.style_root_node.descendants().forEach(node => {
                if (node.data.node_positioning)
                    delete node.data.node_positioning[this.id()];
            });
        }
    }

    update_data(): void {
        this.use_transition = true;

        this._cleanup_style_node_positioning();

        // Remove nodes not belonging to this style
        this._set_hierarchy_filter(this.style_root_node, true);
        this.filtered_descendants = this.style_root_node.descendants();

        // Determine max_depth, used by text positioning
        this.max_depth = 1;
        this.filtered_descendants.forEach(node => {
            this.max_depth = Math.max(this.max_depth, node.depth);
        });

        // Save old coords
        const old_coords = {};
        this.filtered_descendants.forEach(node => {
            old_coords[node.data.id] = {x: node.x, y: node.y};
        });

        // Layout type specific computation
        this._compute_node_offsets();
        this.force_style_translation();

        this._reset_hierarchy_filter(this.style_root_node);

        // Reapply old coords
        this.filtered_descendants.forEach(node => {
            node.x = old_coords[node.data.id].x;
            node.y = old_coords[node.data.id].y;
        });
    }

    // Removes nodes (and their childs) with other explicit styles set
    // A style starts at the root node and ends
    // - At a leaf
    // - At a child node with another explicit style set.
    //    The child node with the style is also included for positioning computing, unless it's detached from the parent
    _set_hierarchy_filter(
        node: NodevisNode,
        first_node = false
    ): NodevisNode[] {
        if (
            (!first_node &&
                node.parent &&
                node.parent.data.use_style &&
                node.parent != this.style_root_node) ||
            (!first_node &&
                node.data.use_style &&
                node.data.use_style.style_config.options.detach_from_parent)
        )
            return [];

        if (node.children) {
            node["children_backup"] = node.children;
            node.children = [];
            for (const idx in node["children_backup"]) {
                const child_node = node["children_backup"][idx];
                node.children = node.children.concat(
                    this._set_hierarchy_filter(child_node)
                );
            }
            if (node.children.length == 0) delete node.children;
        }
        return [node];
    }

    _reset_hierarchy_filter(node: NodevisNode): void {
        if (!node["children_backup"]) return;

        for (const idx in node["children_backup"])
            this._reset_hierarchy_filter(node["children_backup"][idx]);

        node.children = node["children_backup"] as NodevisNode[];
        delete node["children_backup"];
    }

    zoomed(): void {
        // Update style overlays which depend on zoom
        this.generate_overlay();
    }

    get_drag_callback(drag_function): d3.DragBehavior<any, any, any> {
        return d3
            .drag()
            .on("start.drag", event => this._drag_start(event))
            .on("drag.drag", event => this._drag_drag(event, drag_function))
            .on("end.drag", () => this._drag_end());
    }

    _drag_start(event): void {
        this.drag_start_info.start_coords = [event.x, event.y];
        this.drag_start_info.delta = {x: 0, y: 0};
        this.drag_start_info.options = JSON.parse(
            JSON.stringify(this.style_config.options)
        );
        this._world.layout_manager.toolbar_plugin
            .layout_style_configuration()
            .show_style_configuration(this);
        this._world.layout_manager.dragging = true;
    }

    _drag_drag(event, drag_function): void {
        this.drag_start_info.delta.x += event.dx;
        this.drag_start_info.delta.y += event.dy;
        drag_function(event);
        this.changed_options();
    }

    _drag_end(): void {
        this._world.layout_manager.dragging = false;
        this._world.layout_manager.create_undo_step();
    }

    change_rotation(): void {
        let rotation =
            (this.drag_start_info.options.rotation -
                this.drag_start_info.delta.y) %
            360;
        if (rotation < 0) rotation += 360;
        this.style_config.options.rotation = rotation;
        this.force_style_translation();
    }
}

export class LayoutStyleHierarchy extends LayoutStyleHierarchyBase {
    static class_name = "hierarchy";
    static description = "Hierarchical style";

    type(): string {
        return "hierarchy";
    }

    style_color(): string {
        return "#ffa042";
    }

    get_style_options(): StyleOptionDefinition[] {
        return [
            {
                id: "layer_height",
                values: {default: 80, min: 20, max: 500},
                text: "Layer height",
                value: this.style_config.options.layer_height,
                option_type: "range",
            },
            {
                id: "node_size",
                values: {default: 25, min: 15, max: 100},
                text: "Node size",
                value: this.style_config.options.node_size,
                option_type: "range",
            },
            {
                id: "rotation",
                values: {default: 270, min: 0, max: 359},
                text: "Rotation",
                value: this.style_config.options.rotation,
                option_type: "range",
            },
            {
                id: "include_parent_rotation",
                option_type: "checkbox",
                values: {default: false},
                text: "Include parent rotation",
                value: this.style_config.options.include_parent_rotation,
            },
            {
                id: "detach_from_parent",
                option_type: "checkbox",
                values: {default: false},
                text: "Detach from parent style",
                value: this.style_config.options.detach_from_parent,
            },
            {
                id: "box_leaf_nodes",
                option_type: "checkbox",
                values: {default: false},
                text: "Arrange leaf nodes in block",
                value: this.style_config.options.box_leaf_nodes,
            },
        ];
    }

    _compute_node_offsets(): void {
        const rad = (this.get_rotation() / 180) * Math.PI;
        const cos_x = Math.cos(rad);
        const sin_x = Math.sin(rad);

        d3_flextree.flextree().nodeSize(element => {
            const node = element as NodevisNode;
            const node_style: null | AbstractLayoutStyle = node.data.use_style;
            if (node_style && node != this.style_root_node) {
                if (
                    // @ts-ignore
                    node_style.constructor.class_name ==
                    LayoutStyleBlock.class_name
                ) {
                    return node_style.get_size();
                }

                if (node_style.style_config.options.include_parent_rotation) {
                    const rad =
                        ((node_style.style_config.options.rotation as number) /
                            180) *
                        Math.PI;
                    let bounding_rect = {height: 10, width: 10};
                    if (
                        node_style instanceof LayoutStyleHierarchyBase &&
                        node_style.unrotated_vertices.length > 0
                    )
                        bounding_rect = get_bounding_rect_of_rotated_vertices(
                            node_style.unrotated_vertices,
                            rad
                        );
                    return [
                        bounding_rect.height * 1.1 + 100,
                        bounding_rect.width * 1.1 + 100,
                    ];
                }

                let node_rad =
                    ((node_style.style_config.options.rotation as number) /
                        180) *
                    Math.PI;
                node_rad = node_rad + Math.PI - rad;

                let bounding_rect = {height: 10, width: 10};
                if (
                    node_style instanceof LayoutStyleHierarchyBase &&
                    node_style.unrotated_vertices.length > 0
                )
                    bounding_rect = get_bounding_rect_of_rotated_vertices(
                        node_style.unrotated_vertices,
                        node_rad
                    );

                let extra_width = 0;
                if (
                    // @ts-ignore
                    node_style.constructor.class_name ==
                    LayoutStyleHierarchy.class_name
                )
                    extra_width =
                        Math.abs(bounding_rect.height * Math.sin(node_rad)) *
                        0.5;
                return [
                    extra_width + bounding_rect.height * 1.1 + 100,
                    bounding_rect.width * 1.1 + 100,
                ];
            }
            return [
                this.style_config.options.node_size,
                this.style_config.options.layer_height,
            ];
        })(this.style_root_node);

        this._style_root_node_offsets = [];
        this.unrotated_vertices = [];
        for (const idx in this.filtered_descendants) {
            const node = this.filtered_descendants[idx];
            this.unrotated_vertices.push({y: node.x, x: node.y});
            const x = node.x * sin_x + node.y * cos_x;
            const y = node.x * cos_x - node.y * sin_x;
            this._style_root_node_offsets.push([node, x, y]);
        }
    }

    translate_coords(): void {
        if (this._style_translated && this.has_fixed_position()) return;

        const rad = (this.get_rotation() / 180) * Math.PI;
        const text_positioning = this.get_text_positioning(rad);

        this._vertices = [];
        this._vertices.push(
            this._compute_svg_vertex(
                this.style_root_node.x,
                this.style_root_node.y
            )
        );

        const sub_nodes_with_explicit_style: NodevisNode[] = [];
        for (const idx in this._style_root_node_offsets) {
            const entry = this._style_root_node_offsets[idx];
            const node = entry[0];
            const x = entry[1];
            const y = entry[2];

            let apply_style_force = true;
            if (node == this.style_root_node) {
                if (
                    this.style_root_node.data.current_positioning &&
                    this.style_root_node.data.current_positioning.free
                )
                    apply_style_force = true;
                else if (!this.style_root_node.parent) apply_style_force = true;
                else if (this.style_config.options.detach_from_parent)
                    apply_style_force = true;
                else apply_style_force = false;
            }

            if (apply_style_force) {
                const force = this.get_default_node_force(
                    node
                ) as unknown as NodeForce;
                force.fx = this.style_root_node.x + x;
                force.fy = this.style_root_node.y + y;
                force.text_positioning = text_positioning;
                force.use_transition = this.use_transition;
                this._vertices.push(
                    this._compute_svg_vertex(force.fx, force.fy)
                );
            }

            if (node != this.style_root_node && node.data.use_style) {
                sub_nodes_with_explicit_style.push(node);
            }
        }

        // Retranslate styles which's position got shifted
        sub_nodes_with_explicit_style.forEach(node => {
            const used_style = node.data.use_style;
            if (!used_style) return;

            log(
                7,
                "retranslate style " +
                    used_style.type() +
                    " of subnode " +
                    node.data.name
            );
            compute_node_position(node);
            used_style.force_style_translation();
            used_style.translate_coords();
            compute_node_positions_from_list_of_nodes(
                used_style.filtered_descendants
            );
        });

        this.generate_overlay();

        this._style_translated = true;
        this.use_transition = false;
    }

    generate_overlay(): void {
        if (!this._world.layout_manager.edit_layout) return;

        this.selection.attr(
            "transform",
            "scale(" + this._world.viewport.last_zoom.k + ")"
        );

        this.add_enclosing_hull(this.selection, this._vertices);
        const elements = [
            {
                node: this.style_root_node,
                type: "scale",
                image: "themes/facelift/images/icon_resize.png",
                call: this.get_drag_callback(event =>
                    this.resize_layer_drag(event)
                ),
            },
            {
                node: this.style_root_node,
                type: "rotation",
                image: "themes/facelift/images/icon_rotate_left.png",
                call: this.get_drag_callback(() => this.change_rotation()),
            },
        ];
        const coords = this._world.viewport.translate_to_zoom({
            x: this.style_root_node.x,
            y: this.style_root_node.y,
        });
        this.add_option_icons(coords, elements);
    }

    get_text_positioning(rad: number): (x) => any {
        rad = rad / 2;
        if (rad > (3 / 4) * Math.PI) rad = rad - Math.PI;

        let rotate = (-rad / Math.PI) * 180;

        let anchor_options = ["start", "end"];
        const boundary = (9 / 32) * Math.PI;

        const left_side = rad > boundary && rad < Math.PI - boundary;

        const distance = 21;
        const x = Math.cos(-rad * 2) * distance;
        const y = Math.sin(-rad * 2) * distance;

        if (rad > Math.PI - boundary) {
            rotate += 180;
        } else if (left_side) {
            rotate += 90;
            anchor_options = ["end", "start"];
        }

        const text_anchor = anchor_options[0];
        const transform_text =
            "translate(" + x + "," + y + ") rotate(" + rotate + ")";
        return selection => {
            selection
                .attr("transform", transform_text)
                .attr("text-anchor", text_anchor);
        };
    }

    resize_layer_drag(event: MouseEvent): void {
        const rotation_rad =
            ((this.style_config.options.rotation as number) / 180) * Math.PI;
        const coords = d3.pointer(event);
        const offset_y = this.drag_start_info.start_coords[0] - coords[0];
        const offset_x = this.drag_start_info.start_coords[1] - coords[1];

        const dx_scale =
            (100 +
                (Math.cos(-rotation_rad) * offset_x -
                    Math.sin(-rotation_rad) * offset_y)) /
            100;
        const dy_scale =
            (100 -
                (Math.cos(-rotation_rad) * offset_y +
                    Math.sin(-rotation_rad) * offset_x)) /
            100;

        const node_size =
            (this.drag_start_info.options.node_size as number) * dx_scale;
        const layer_height =
            (this.drag_start_info.options.layer_height as number) * dy_scale;

        this.style_config.options.node_size = Math.floor(
            Math.max(
                (this._default_options.node_size as number) / 2,
                Math.min(
                    (this._default_options.node_size as number) * 8,
                    node_size
                )
            )
        );
        this.style_config.options.layer_height = Math.floor(
            Math.max(
                (this._default_options.layer_height as number) / 2,
                Math.min(
                    (this._default_options.layer_height as number) * 8,
                    layer_height
                )
            )
        );
    }

    get_hierarchy_size(): RectangleWithCoords {
        const max_elements_per_layer = {};

        this.filtered_descendants.forEach(node => {
            if (node.children == null) return;
            if (max_elements_per_layer[node.depth] == null)
                max_elements_per_layer[node.depth] = 0;

            max_elements_per_layer[node.depth] += node.children.length;
        });
        this._layer_count = this.max_depth - this.style_root_node.depth + 2;

        let highest_density = 0;
        for (const idx in max_elements_per_layer)
            highest_density = Math.max(
                highest_density,
                max_elements_per_layer[idx]
            );

        const width =
            highest_density * (this.style_config.options.node_size as number);
        const height =
            this._layer_count *
            (this.style_config.options.layer_height as number);

        return {
            x: this.style_root_node.x,
            y: this.style_root_node.y,
            width: width,
            height: height,
        };
    }
}

export class LayoutStyleRadial extends LayoutStyleHierarchyBase {
    static class_name = "radial";
    static description = "Radial style";
    _text_rotations: number[] = [];

    type(): string {
        return "radial";
    }

    style_color(): string {
        return "#13d389";
    }

    get_style_options(): StyleOptionDefinition[] {
        return [
            {
                id: "radius",
                option_type: "range",
                values: {default: 120, min: 30, max: 300},
                text: "Radius",
                value: this.style_config.options.radius,
            },
            {
                id: "degree",
                option_type: "range",
                values: {default: 360, min: 10, max: 360},
                text: "Degree",
                value: this.style_config.options.degree,
            },
            {
                id: "rotation",
                option_type: "range",
                values: {default: 0, min: 0, max: 359},
                text: "Rotation",
                value: this.style_config.options.rotation,
            },
            {
                id: "include_parent_rotation",
                option_type: "checkbox",
                values: {default: false},
                text: "Include parent rotation",
                value: this.style_config.options.include_parent_rotation,
            },
            {
                id: "detach_from_parent",
                option_type: "checkbox",
                values: {default: false},
                text: "Detach from parent style",
                value: this.style_config.options.detach_from_parent,
            },
        ];
    }

    _compute_node_offsets(): void {
        const radius =
            (this.style_config.options.radius as number) *
            (this.max_depth - this.style_root_node.depth + 1);
        const rad = (this.get_rotation() / 180) * Math.PI;
        const tree = d3
            .cluster()
            .size([
                ((this.style_config.options.degree as number) / 360) *
                    2 *
                    Math.PI,
                radius,
            ]);

        this._style_root_node_offsets = [];
        this._text_rotations = [];
        this.unrotated_vertices = [];
        if (this.filtered_descendants.length == 1) {
            this._style_root_node_offsets.push([this.style_root_node, 0, 0]);
            this._text_rotations.push(0);
        } else {
            tree(this.style_root_node);
            for (const idx in this.filtered_descendants) {
                const node = this.filtered_descendants[idx];

                let radius_reduction = 0;
                if (!node.children) {
                    radius_reduction =
                        (this.style_config.options.radius as number) * 1;
                }
                this.unrotated_vertices.push({
                    x: Math.cos(node.x) * (node.y - radius_reduction),
                    y: -Math.sin(node.x) * (node.y - radius_reduction),
                });

                const x = Math.cos(node.x + rad) * (node.y - radius_reduction);
                const y = -Math.sin(node.x + rad) * (node.y - radius_reduction);
                this._style_root_node_offsets.push([node, x, y]);
                this._text_rotations.push((node.x + rad) % (2 * Math.PI));
            }
        }
    }

    translate_coords(): void {
        if (this._style_translated && this.has_fixed_position()) return;

        const offsets: Coords = {
            x: this.style_root_node.x,
            y: this.style_root_node.y,
        };

        const retranslate_styled_sub_nodes: NodevisNode[] = [];

        for (const idx in this._style_root_node_offsets) {
            const entry = this._style_root_node_offsets[idx];
            const node = entry[0];
            const x = entry[1];
            const y = entry[2];

            if (
                (node == this.style_root_node &&
                    this.style_config.options.detach_from_parent) ||
                node != this.style_root_node ||
                !this.style_root_node.parent
            ) {
                const force = this.get_default_node_force(
                    node
                ) as unknown as NodeForce;
                force.fx = offsets.x + x;
                force.fy = offsets.y + y;
                force.text_positioning = this._get_radial_text_positioning(
                    entry,
                    this._text_rotations[idx]
                );
                force.use_transition = this.use_transition;
            }

            if (node != this.style_root_node && node.data.use_style) {
                retranslate_styled_sub_nodes.push(node);
            }
            // TODO: check this
            // @ts-ignore
            node.force = -500;
        }

        // Retranslate styles which's position got shifted
        retranslate_styled_sub_nodes.forEach(node => {
            compute_node_position(node);
            const used_style = node.data.use_style;
            if (used_style) used_style.translate_coords();
        });

        this.generate_overlay();
        this.use_transition = false;
        this._style_translated = true;
    }

    _get_radial_text_positioning(
        entry,
        node_rad: number
    ): (d3SelectionSvg) => void {
        const node = entry[0];

        if (this.style_root_node == node) return () => null;

        this._layer_count = this.max_depth - this.style_root_node.depth + 1;
        let rotate = (-node_rad / Math.PI) * 180;

        let anchor_options = ["start", "end"];
        const is_circle_left_side =
            node_rad > Math.PI / 2 && node_rad < (3 / 2) * Math.PI;
        if (is_circle_left_side) {
            rotate += 180;
            anchor_options = ["end", "start"];
        }

        let x = Math.cos(-node_rad) * 12;
        let y = Math.sin(-node_rad) * 12;
        const toggle_text_anchor = node.height > 0;

        let text_anchor = anchor_options[0];
        if (toggle_text_anchor) {
            x = -x;
            y = -y;
            text_anchor = anchor_options[1];
        }

        const transform_text =
            "translate(" + x + "," + y + ") rotate(" + rotate + ")";
        return selection => {
            selection
                .attr("transform", transform_text)
                .attr("text-anchor", text_anchor);
        };
    }

    generate_overlay(): void {
        if (!this._world.layout_manager.edit_layout) return;

        this.selection.attr(
            "transform",
            "scale(" + this._world.viewport.last_zoom.k + ")"
        );

        const degree = Math.min(
            360,
            Math.max(0, this.style_config.options.degree as number)
        );
        const end_angle = (degree / 180) * Math.PI;

        const arc = d3
            .arc()
            .innerRadius(25)
            .outerRadius(
                (this.style_config.options.radius as number) *
                    (this.max_depth - this.style_root_node.depth + 1)
            )
            .startAngle(2 * Math.PI - end_angle + Math.PI / 2)
            .endAngle(2 * Math.PI + Math.PI / 2);

        let rotation_overlay = this.selection
            .selectAll<SVGGElement, null>("g.rotation_overlay")
            .data([null]);
        rotation_overlay = rotation_overlay
            .enter()
            .append("g")
            .classed("rotation_overlay", true)
            .merge(rotation_overlay);
        rotation_overlay.attr(
            "transform",
            "translate(" +
                this.style_root_node.x +
                "," +
                this.style_root_node.y +
                ")" +
                "rotate(" +
                -this.get_rotation() +
                ")"
        );

        // Arc
        let path = rotation_overlay
            .selectAll<SVGPathElement, null>("path")
            .data([null]);
        path = path
            .enter()
            .append("path")
            .classed("style_overlay", true)
            .style("opacity", 0)
            .merge(path);
        this.add_optional_transition(path)
            .attr("d", arc)
            .style("opacity", null);

        // Icons
        const elements = [
            {
                node: this.style_root_node,
                type: "radius",
                image: "themes/facelift/images/icon_resize.png",
                call: this.get_drag_callback(() => this.change_radius()),
            },
            {
                node: this.style_root_node,
                type: "rotation",
                image: "themes/facelift/images/icon_rotate_left.png",
                call: this.get_drag_callback(() => this.change_rotation()),
            },
            {
                node: this.style_root_node,
                type: "degree",
                image: "themes/facelift/images/icon_pie_chart.png",
                call: this.get_drag_callback(() => this.change_degree()),
            },
        ];
        const coords = this._world.viewport.translate_to_zoom({
            x: this.style_root_node.x,
            y: this.style_root_node.y,
        });
        this.add_option_icons(coords, elements);
    }

    change_radius(): void {
        this._world.layout_manager.toolbar_plugin
            .layout_style_configuration()
            .show_style_configuration(this);
        this.style_config.options.radius = Math.floor(
            Math.min(
                500,
                Math.max(
                    10,
                    (this.drag_start_info.options.radius as number) -
                        this.drag_start_info.delta.y
                )
            )
        );
        this.changed_options();
    }

    change_degree(): void {
        this._world.layout_manager.toolbar_plugin
            .layout_style_configuration()
            .show_style_configuration(this);
        const degree = Math.floor(
            Math.min(
                360,
                Math.max(
                    10,
                    (this.drag_start_info.options.degree as number) -
                        this.drag_start_info.delta.y
                )
            )
        );
        this.style_config.options.degree = degree;
        this.changed_options();
    }
}

export class LayoutStyleFixed extends AbstractLayoutStyle {
    static class_name = "fixed";
    static description = "Fixed position style";

    type(): string {
        return "fixed";
    }

    style_color(): string {
        return "Burlywood";
    }

    positioning_weight(): number {
        return 100;
    }

    update_data(): void {
        this.fix_node(this.style_root_node);
    }
}

export class LayoutStyleBlock extends LayoutStyleHierarchyBase {
    static class_name = "block";
    static description = "Leaf-Nodes Block style";
    _width = 0;
    _height = 0;
    _leaf_childs: NodevisNode[] = [];

    type(): string {
        return "block";
    }

    style_color(): string {
        return "#3cc2ff";
    }

    get_style_options(): StyleOptionDefinition[] {
        return [
            {
                id: "detach_from_parent",
                option_type: "checkbox",
                values: {default: false},
                text: "Detach from parent style",
                value: this.style_config.options.detach_from_parent,
            },
        ];
    }

    _compute_node_offsets(): void {
        this._leaf_childs = [];
        if (!this.style_root_node.children) return;

        // Group only leaf childs
        this._leaf_childs = [];
        this.style_root_node.children.forEach(child => {
            if (child._children) return;
            this._leaf_childs.push(child);
        });

        const node_width = 50;
        const width = Math.sqrt(this._leaf_childs.length) * node_width;
        const max_cols = Math.floor(width / node_width);

        this._width = width;
        this._height = node_width / 2;

        this._style_root_node_offsets = [];
        this._style_root_node_offsets.push([this.style_root_node, 0, 0]);
        for (const idx in this._leaf_childs) {
            const idx_num = parseInt(idx);
            const node = this._leaf_childs[idx];
            const row_no = Math.floor(idx_num / max_cols) + 1;
            const col_no = idx_num % max_cols;
            this._height = (row_no * node_width) / 2;
            // TODO: remove previous version
            //this._style_root_node_offsets.push({
            //    node: node,
            //    x: -width / 2 + node_width / 2 + col_no * node_width,
            //    y: (row_no * node_width) / 2,
            //});
            this._style_root_node_offsets.push([
                node,
                -width / 2 + node_width / 2 + col_no * node_width,
                (row_no * node_width) / 2,
            ]);
        }
        this.use_transition = true;
    }

    get_size(): [number, number] {
        return [this._width * 1.1, this._height];
    }

    translate_coords(): void {
        if (this._style_root_node_offsets.length == 0) return;

        log(
            7,
            "translating block style, fixed positing:" +
                this.has_fixed_position()
        );

        const abs_offsets: [number, number] = [
            this.style_root_node.x,
            this.style_root_node.y,
        ];

        this._style_root_node_offsets.forEach(offset => {
            const force = this.get_default_node_force(
                offset[0]
            ) as unknown as NodeForce;
            force.fx = abs_offsets[0] + offset[1];
            force.fy = abs_offsets[1] + offset[2];
            force.use_transition = this.use_transition;
            if (offset[0] != this.style_root_node) force.hide_node_link = true;
            force.text_positioning = (selection, radius) =>
                selection
                    .attr(
                        "transform",
                        "translate(" +
                            radius +
                            "," +
                            (radius + 4) +
                            ") rotate(45)"
                    )
                    .attr("text-anchor", "start");
            // TODO: check this, changed refs to index, removed force-500
            //offset.node.force = -500;
        });

        this.generate_overlay();
        this.use_transition = false;
        this._style_translated = true;
    }

    update_gui(): void {
        this.generate_overlay();
    }

    generate_overlay(): void {
        if (this._style_root_node_offsets.length < 2) return;

        this.selection.attr(
            "transform",
            "scale(" + this._world.viewport.last_zoom.k + ")"
        );

        const boundary = 10;
        const hull_vertices: [number, number][] = [];
        const abs_offsets = {
            x: this.style_root_node.x,
            y: this.style_root_node.y,
        };
        this._style_root_node_offsets.forEach(offset => {
            if (offset[0] == this.style_root_node) return;
            hull_vertices.push([
                offset[1] + boundary + abs_offsets.x,
                offset[2] + boundary + abs_offsets.y,
            ]);
            hull_vertices.push([
                offset[1] - boundary + abs_offsets.x,
                offset[2] - boundary + abs_offsets.y,
            ]);
            hull_vertices.push([
                offset[1] + boundary + abs_offsets.x,
                offset[2] - boundary + abs_offsets.y,
            ]);
            hull_vertices.push([
                offset[1] - boundary + abs_offsets.x,
                offset[2] + boundary + abs_offsets.y,
            ]);
        });
        let hull = this.selection
            .selectAll<SVGPathElement, [number, number][]>(
                "path.children_boundary"
            )
            .data([d3.polygonHull(hull_vertices)]);
        hull = hull
            .enter()
            .append("path")
            .classed("children_boundary", true)
            .classed("block_style_overlay", true)
            .attr("pointer-events", "none")
            .style("opacity", 0)
            .merge(hull);
        this.add_optional_transition(
            hull.attr("d", function (d) {
                if (d == null) return "";
                return "M" + d.join("L") + "Z";
            })
        ).style("opacity", null);

        const connection_line = this.selection
            .selectAll<SVGLineElement, null>("line.root_children_connection")
            .data([null]);
        connection_line
            .enter()
            .append("line")
            .classed("root_children_connection", true)
            .classed("block_style_overlay", true)
            .merge(connection_line)
            .attr("x1", this.style_root_node.x)
            .attr("y1", this.style_root_node.y)
            .attr("x2", this.style_root_node.x)
            .attr("y2", this.style_root_node.y + 15);
    }
}

layout_style_class_registry.register(LayoutStyleForce);
layout_style_class_registry.register(LayoutStyleHierarchy);
layout_style_class_registry.register(LayoutStyleRadial);
layout_style_class_registry.register(LayoutStyleBlock);
layout_style_class_registry.register(LayoutStyleFixed);
