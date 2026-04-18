import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import GlobalError from "./global-error";

describe("GlobalError", () => {
  it("renders without intl provider context", () => {
    expect(() =>
      renderToStaticMarkup(<GlobalError error={new Error("boom")} reset={() => {}} />)
    ).not.toThrow();

    const html = renderToStaticMarkup(
      <GlobalError error={new Error("boom")} reset={() => {}} />
    );

    expect(html).toContain("Something went wrong");
  });
});
