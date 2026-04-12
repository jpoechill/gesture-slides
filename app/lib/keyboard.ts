/** True for textarea / select / text-like inputs / contenteditable — not checkbox, range, or button inputs. */
export function isEditableTextKeyboardTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName?.toLowerCase();
  if (tag === "textarea") return true;
  if (tag === "select") return true;
  if (tag === "input") {
    const t = ((el as HTMLInputElement).type ?? "text").toLowerCase();
    if (
      t === "checkbox" ||
      t === "radio" ||
      t === "range" ||
      t === "button" ||
      t === "submit" ||
      t === "reset" ||
      t === "file" ||
      t === "color" ||
      t === "hidden"
    )
      return false;
    return true;
  }
  return el.getAttribute?.("contenteditable") === "true";
}
