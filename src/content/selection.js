// The selected text, taken as one replaceable piece.
//
// Two kinds of selection, one shape handed back for both. Text in the page is wrapped in a span of
// ours, because a selection is not a block: it starts and ends wherever the user let go, and it can
// cross elements the page, not the reader, decided to put there. Text inside an input or a textarea
// is not in the DOM at all and no selection API reports it, so that kind is a range of characters in
// the field's value instead. Either way the caller gets one element to mark, one string to send, and
// two ways of writing to it.

import { scriptGroup } from "../lib/script.js";
import { ATTR_STATE } from "../lib/rules.js";

const FIELDS = new Set(["INPUT", "TEXTAREA"]);
// A selection ends where the pointer was let go, which is often a hair outside its own rectangle.
const EDGE = 3;

const covers = (rect, at) =>
  at.x >= rect.left - EDGE && at.x <= rect.right + EDGE &&
  at.y >= rect.top - EDGE && at.y <= rect.bottom + EDGE;

// What a press would act on, without acting. `at` is the pointer, and passing it asks the narrower
// question the shared key needs: not whether anything is selected, but whether the selection is the
// thing being pointed at. A key of its own passes nothing and takes the selection wherever it is.
export function selectionAt(at) {
  return findField(at) || findRange(at);
}

export function takeSelection(at) {
  const found = selectionAt(at);
  if (!found) return null;
  return found.field ? takeField(found) : takeRange(found);
}

function findField(at) {
  const field = document.activeElement;
  if (!field || !FIELDS.has(field.tagName)) return null;
  // Not text to be read: it would be sent to a translation endpoint like anything else.
  if (field.type === "password") return null;
  // Nothing could be written back, so there is nothing here to take.
  if (field.readOnly || field.disabled) return null;
  // Chrome refuses selectionStart on the types that hold no free text, checkboxes and dates among
  // them, and reading it is the shortest way to ask whether this field has any.
  let start;
  let end;
  try {
    start = field.selectionStart;
    end = field.selectionEnd;
  } catch {
    return null;
  }
  if (typeof start !== "number" || !(end > start)) return null;
  if (!field.value.slice(start, end).trim()) return null;
  if (at && !covers(field.getBoundingClientRect(), at)) return null;
  return { field, start, end };
}

function findRange(at) {
  const selection = window.getSelection?.();
  if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
  const text = selection.toString().trim();
  if (!text) return null;

  const range = selection.getRangeAt(0);
  const scope = range.commonAncestorContainer;
  const element = scope.nodeType === Node.ELEMENT_NODE ? scope : scope.parentElement;
  if (!element) return null;
  // Text the page expects to own the shape of: an editor would serialise this wrapper into whatever
  // is being written, and there is no telling where that gets saved.
  if (element.isContentEditable) return null;
  // Our own overlays, and anything already replaced: nesting one of these inside another gives the
  // inner one a parent that undoing the outer one takes away.
  if (element.closest(`[data-ht-ui],[${ATTR_STATE}]`)) return null;
  if (at && ![...range.getClientRects()].some((rect) => covers(rect, at))) return null;
  return { range, text };
}

function takeField({ field, start, end }) {
  const original = field.value.slice(start, end);
  // What stands in the field right now for that range, so a write can tell whether the user has
  // typed since and the offsets no longer mean anything.
  let shown = original;

  const write = (next) => {
    if (field.value.slice(start, start + shown.length) !== shown) return;
    field.focus();
    field.setSelectionRange(start, start + shown.length);
    // Through the editing command rather than by assigning to value: this is the one that keeps the
    // field's own undo history and fires the input event, without which a framework-held field is
    // rewritten from its state the next time anything renders.
    if (!document.execCommand("insertText", false, next)) {
      field.setRangeText(next, start, start + shown.length, "end");
      field.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: next }));
    }
    shown = next;
  };

  return {
    element: field,
    text: original.trim(),
    group: scriptGroup(original),
    // What is typed here is the user's own text, not a view of the page. Once it is translated the
    // translation is what they wrote, so nothing marks the field and nothing offers to put it back:
    // the field's own undo does that, which is why the write goes through the editing command.
    editable: true,
    replace: write,
    restore: () => write(original),
  };
}

function takeRange({ range, text }) {
  const holder = document.createElement("span");
  holder.append(range.extractContents());
  // Kept by reference, so putting them back is those very nodes returning rather than a copy.
  const nodes = Array.from(holder.childNodes);
  range.insertNode(holder);

  return {
    element: holder,
    text,
    group: scriptGroup(text),
    replace: (next) => {
      holder.textContent = next;
    },
    restore: () => {
      if (!holder.isConnected) return;
      const parent = holder.parentNode;
      holder.replaceWith(...nodes);
      // Taking the range out split the text node it started in, so handing the middle piece back
      // leaves three fragments where the page had one sentence, the first of them empty whenever the
      // selection began at a boundary. Merging them is what makes this a restore.
      parent?.normalize();
    },
  };
}
