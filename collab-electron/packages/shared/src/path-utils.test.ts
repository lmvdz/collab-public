import { describe, expect, test } from "bun:test";
import {
  displayBasename,
  displayCommandName,
  isSubpath,
  joinPath,
  normalizeCommandName,
  parentPath,
  parseWslUncPath,
  pathKind,
  windowsPathToWslPath,
} from "./path-utils";

describe("path-utils", () => {
  test("detects path kinds", () => {
    expect(pathKind("/tmp/work")).toBe("posix");
    expect(pathKind("C:\\repo\\work")).toBe("windows");
    expect(pathKind("\\\\wsl$\\Ubuntu\\home\\me\\work")).toBe("wsl-unc");
  });

  test("matches subpaths across separators", () => {
    expect(isSubpath("C:\\repo", "C:\\repo\\src\\index.ts")).toBe(true);
    expect(isSubpath("/repo", "/repo/src/index.ts")).toBe(true);
    expect(
      isSubpath(
        "\\\\wsl$\\Ubuntu\\home\\me",
        "\\\\wsl$\\Ubuntu\\home\\me\\repo\\file.ts",
      ),
    ).toBe(true);
  });

  test("converts Windows paths to WSL mount paths", () => {
    expect(windowsPathToWslPath("C:\\repo\\src")).toBe("/mnt/c/repo/src");
  });

  test("parses WSL UNC paths", () => {
    expect(
      parseWslUncPath("\\\\wsl$\\Ubuntu\\home\\me\\repo"),
    ).toEqual({
      distro: "Ubuntu",
      guestPath: "/home/me/repo",
    });
  });

  test("joins and trims platform paths", () => {
    expect(joinPath("C:\\repo", "src")).toBe("C:\\repo\\src");
    expect(parentPath("C:\\repo\\src\\index.ts")).toBe("C:\\repo\\src");
    expect(displayBasename("/tmp/work/file.ts")).toBe("file.ts");
  });

  test("normalizes executable command names for comparison", () => {
    expect(displayCommandName("C:\\Program Files\\PowerShell\\7\\pwsh.exe")).toBe("pwsh");
    expect(normalizeCommandName("PowerShell.EXE")).toBe("powershell");
    expect(normalizeCommandName("/bin/bash")).toBe("bash");
  });
});
