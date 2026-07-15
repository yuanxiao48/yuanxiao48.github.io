import definitions from "./widgetRegistry.json";
import type { WidgetComponentType } from "../types/sidebarConfig";

export type WidgetRegistryEntry = {
	type: WidgetComponentType;
	name: string;
	description: string;
};

/** Shared sidebar widget catalogue used by the public layout and Studio. */
export const widgetRegistry = definitions as WidgetRegistryEntry[];
export const widgetTypes = new Set<WidgetComponentType>(
	widgetRegistry.map((widget) => widget.type),
);
