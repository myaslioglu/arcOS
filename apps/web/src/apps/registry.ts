import type { AppManifest } from "@arcos/shell";
import { about } from "./about/manifest";
import { wallet } from "./wallet/manifest";

/** Desktop order. Every app in the product is listed here and nowhere else. */
export const APPS: AppManifest[] = [wallet, about];
