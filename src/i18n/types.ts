import type en from "./en";

export type Language = "en" | "es";
export type TranslationKey = keyof typeof en;
