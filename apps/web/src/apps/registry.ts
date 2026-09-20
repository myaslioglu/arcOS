import type { AppManifest } from "@arcos/shell";
import { about } from "./about/manifest";
import { finder } from "./finder/manifest";
import { inspector } from "./inspector/manifest";
import { wallet } from "./wallet/manifest";
import { SOON } from "./soon";

/** Desktop order. Every app in the product is listed here and nowhere else. */
export const APPS: AppManifest[] = [finder, wallet, about, inspector, ...SOON];
