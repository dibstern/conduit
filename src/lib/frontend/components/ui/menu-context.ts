import type { MenuItemDensity } from "./floating-styles.js";

export const menuDensityContextKey = Symbol("menu-density");
export type MenuDensityContext = () => MenuItemDensity;
