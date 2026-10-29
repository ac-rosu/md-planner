// A small "form" built on the quick pick: the first entries are actions (the first one runs on
// Enter), followed by one entry per field with its current value. Choosing a field opens its own
// picker or input box and returns to the form; Escape on the form cancels (after asking, when
// fields were changed).
import * as vscode from "vscode";

export interface FormField<S> {
  icon: string;
  label: string;
  /** Current value shown next to the label; undefined shows "—". */
  value(state: S): string | undefined;
  /** Opens the field's own picker or input; changes `state`. Escape there keeps the old value. */
  edit(state: S): Promise<void>;
  visible?(state: S): boolean;
  /** Marks the field as changed (●). */
  changed?(state: S): boolean;
  /** Explains the field in the second line of the entry. */
  detail?: string;
}

export interface FormAction {
  id: string;
  icon: string;
  label: string;
  description?: string;
}

export interface FormOptions<S> {
  title: string;
  state: S;
  /** Actions above the fields; the first one is selected, so Enter runs it. */
  actions: FormAction[];
  fields: Array<FormField<S>>;
  /** Further actions below the fields (move, delete, open the file …). */
  more?: FormAction[];
  placeholder?: string;
}

type Item = vscode.QuickPickItem & { action?: string; field?: number };

/** Shows the form until an action is chosen (its id is returned) or it is cancelled. */
export async function showForm<S>(o: FormOptions<S>): Promise<string | undefined> {
  const initial = JSON.stringify(o.state);
  for (;;) {
    const items: Item[] = o.actions.map((a) => ({
      label: `$(${a.icon}) ${a.label}`,
      description: a.description,
      action: a.id,
      alwaysShow: true,
    }));
    items.push({ label: "Fields", kind: vscode.QuickPickItemKind.Separator });
    o.fields.forEach((f, i) => {
      if (f.visible && !f.visible(o.state)) return;
      const value = f.value(o.state);
      items.push({
        label: `$(${f.icon}) ${f.label}`,
        description: `${f.changed?.(o.state) ? "● " : ""}${value === undefined || value === "" ? "—" : value}`,
        detail: f.detail,
        field: i,
      });
    });
    if (o.more?.length) {
      items.push({ label: "More", kind: vscode.QuickPickItemKind.Separator });
      for (const a of o.more)
        items.push({ label: `$(${a.icon}) ${a.label}`, description: a.description, action: a.id });
    }
    const pick = await vscode.window.showQuickPick(items, {
      title: o.title,
      placeHolder: o.placeholder ?? "Choose a field to change, or press Enter",
      ignoreFocusOut: true,
      matchOnDescription: true,
    });
    if (!pick) {
      if (JSON.stringify(o.state) === initial) return undefined;
      const [primary] = o.actions;
      const choice = await vscode.window.showWarningMessage(
        `${o.title}: keep your changes?`,
        { modal: true, detail: "Cancel goes back to the form." },
        primary.label,
        "Discard"
      );
      if (choice === primary.label) return primary.id;
      if (choice === "Discard") return undefined;
      continue;
    }
    if (
      pick.action &&
      JSON.stringify(o.state) !== initial &&
      o.more?.some((a) => a.id === pick.action)
    ) {
      // A further action leaves the form: say that the changes made in it are not saved.
      const discard = "Discard changes";
      const choice = await vscode.window.showWarningMessage(
        `${o.title}: your changes are not saved yet.`,
        {
          modal: true,
          detail: `${pick.label.replace(/^\$\([^)]*\)\s*/, "")} leaves the form without saving them. Cancel goes back to the form, where ${o.actions[0].label} saves them.`,
        },
        discard
      );
      if (choice !== discard) continue;
    }
    if (pick.action) return pick.action;
    if (pick.field !== undefined) await o.fields[pick.field].edit(o.state);
  }
}
