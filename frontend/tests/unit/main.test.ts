/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const render = vi.fn();
const createRoot = vi.fn(() => ({ render, unmount: vi.fn() }));

vi.mock("react-dom/client", () => ({ createRoot }));

/** index.html's mount point. The entry module looks for exactly this element. */
function installRootElement(): HTMLElement {
  const root = document.createElement("div");
  root.id = "root";
  document.body.append(root);
  return root;
}

beforeEach(() => {
  // Each case needs a fresh module instance: importing the entry point is
  // itself the behaviour under test, and ESM caches it after the first import.
  vi.resetModules();
  createRoot.mockClear();
  render.mockClear();
  document.body.innerHTML = "";
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("main", () => {
  it("should mount automatically into #root when the module is imported", async () => {
    const root = installRootElement();

    await import("../../src/main");

    expect(createRoot).toHaveBeenCalledWith(root);
    expect(render).toHaveBeenCalledTimes(1);
  });

  it("should mount into whatever container mount() is handed", async () => {
    installRootElement();
    const container = document.createElement("div");
    document.body.append(container);

    const { mount } = await import("../../src/main");
    mount(container);

    expect(createRoot).toHaveBeenLastCalledWith(container);
  });

  it("should fail loudly when index.html has no #root, rather than render nothing", async () => {
    await expect(import("../../src/main")).rejects.toThrow(/#root/);
  });
});
