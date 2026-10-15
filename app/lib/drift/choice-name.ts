/**
 * A drift decision's accessible name: which variant, and for Keep, what it does to the
 * baseline (#796). Three identical names a row, and the consequential one told apart only
 * by colour, gave a screen-reader user nothing to choose by.
 */
export function choiceName(choice: "adopt" | "reassert" | "ignore", title: string): string {
  switch (choice) {
    case "adopt":
      return `Keep the change to ${title}, and make it the new baseline`;
    case "reassert":
      return `Put the campaign's price back on ${title}`;
    case "ignore":
      return `Leave ${title} for now`;
  }
}
