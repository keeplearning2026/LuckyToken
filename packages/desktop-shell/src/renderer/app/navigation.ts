export type ProductPage = "overview" | "providers" | "settings";

export const productPages: ReadonlyArray<Readonly<{
  id: ProductPage;
  label: string;
  tone: "red" | "yellow" | "blue";
}>> = Object.freeze([
  { id: "overview", label: "Overview", tone: "red" },
  { id: "providers", label: "Providers", tone: "yellow" },
  { id: "settings", label: "Settings", tone: "blue" },
]);
