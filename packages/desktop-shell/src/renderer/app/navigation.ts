export type ProductPage = "home" | "providers" | "connect" | "activity" | "settings";

export const productPages: ReadonlyArray<Readonly<{
  id: ProductPage;
  label: string;
}>> = Object.freeze([
  { id: "home", label: "Home" },
  { id: "providers", label: "Providers" },
  { id: "connect", label: "Connect" },
  { id: "activity", label: "Activity" },
  { id: "settings", label: "Settings" },
]);
