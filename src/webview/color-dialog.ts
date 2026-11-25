import { clamp, isOpacity, opaquePercent } from "../annotation";

interface HsvColor {
  hue: number;
  saturation: number;
  value: number;
}

function hexToHsv(hex: string, previousHue: number): HsvColor {
  const rgb = Number.parseInt(hex.replace(/^#/, ""), 16);
  const red = (rgb >> 16) / 255;
  const green = ((rgb >> 8) & 255) / 255;
  const blue = (rgb & 255) / 255;
  const value = Math.max(red, green, blue);
  const chroma = value - Math.min(red, green, blue);
  if (!chroma) return { hue: previousHue, saturation: 0, value };
  const sector = value === red ? (green - blue) / chroma
    : value === green ? (blue - red) / chroma + 2 : (red - green) / chroma + 4;
  return { hue: (sector * 60 + 360) % 360, saturation: chroma / value, value };
}

function hsvToHex({ hue, saturation, value }: HsvColor): string {
  const channel = (offset: number) => {
    const sector = (offset + hue / 60) % 6;
    const component = value * (1 - saturation * Math.max(0, Math.min(sector, 4 - sector, 1)));
    return Math.round(component * 255).toString(16).padStart(2, "0");
  };
  return `#${channel(5)}${channel(3)}${channel(1)}`;
}

export function updateColorSwatch(swatch: HTMLElement, color: string, opacity: number): void {
  swatch.style.backgroundColor = color;
  swatch.style.opacity = String(opacity / opaquePercent);
}

export function createColorDialog(dialog: HTMLDialogElement) {
  const form = dialog.querySelector<HTMLFormElement>("#color-form")!;
  const title = dialog.querySelector<HTMLElement>("#color-title")!;
  const plane = dialog.querySelector<HTMLElement>("#color-plane")!;
  const hue = dialog.querySelector<HTMLInputElement>("#color-hue")!;
  const hex = dialog.querySelector<HTMLInputElement>("#color-hex")!;
  const slider = dialog.querySelector<HTMLInputElement>("#color-opacity-slider")!;
  const opacity = dialog.querySelector<HTMLInputElement>("#color-opacity")!;
  const preview = dialog.querySelector<HTMLElement>("#color-preview > span")!;
  let hsv: HsvColor = { hue: 0, saturation: 0, value: 0 };
  let applyColor: (color: string, opacity: number) => void;

  function renderColor(): void {
    const color = hsvToHex(hsv);
    dialog.style.setProperty("--picker-color", color);
    plane.style.setProperty("--picker-hue", String(hsv.hue));
    plane.style.setProperty("--picker-x", `${hsv.saturation * 100}%`);
    plane.style.setProperty("--picker-y", `${(1 - hsv.value) * 100}%`);
    updateColorSwatch(preview, color, slider.valueAsNumber);
  }

  function changeFromPlane({ clientX, clientY }: PointerEvent): void {
    const { left, top, width, height } = plane.getBoundingClientRect();
    hsv.saturation = clamp((clientX - left) / width, 0, 1);
    hsv.value = 1 - clamp((clientY - top) / height, 0, 1);
    hex.value = hsvToHex(hsv);
    renderColor();
  }

  plane.addEventListener("pointerdown", event => {
    if (event.button !== 0) return;
    plane.setPointerCapture(event.pointerId);
    changeFromPlane(event);
  });
  plane.addEventListener("pointermove", event => {
    if (plane.hasPointerCapture(event.pointerId)) changeFromPlane(event);
  });
  plane.addEventListener("keydown", event => {
    const step = event.shiftKey ? 0.1 : 0.01;
    switch (event.key) {
      case "ArrowLeft": hsv.saturation = clamp(hsv.saturation - step, 0, 1); break;
      case "ArrowRight": hsv.saturation = clamp(hsv.saturation + step, 0, 1); break;
      case "ArrowDown": hsv.value = clamp(hsv.value - step, 0, 1); break;
      case "ArrowUp": hsv.value = clamp(hsv.value + step, 0, 1); break;
      default: return;
    }
    event.preventDefault();
    hex.value = hsvToHex(hsv);
    renderColor();
  });
  hue.addEventListener("input", () => {
    hsv.hue = hue.valueAsNumber;
    hex.value = hsvToHex(hsv);
    renderColor();
  });
  hex.addEventListener("input", () => {
    if (!hex.validity.valid) return;
    hsv = hexToHsv(hex.value, hsv.hue);
    hue.valueAsNumber = hsv.hue;
    renderColor();
  });
  opacity.addEventListener("input", () => {
    if (!isOpacity(opacity.valueAsNumber)) return;
    slider.valueAsNumber = opacity.valueAsNumber;
    renderColor();
  });
  slider.addEventListener("input", () => {
    opacity.value = slider.value;
    renderColor();
  });
  dialog.querySelector("#color-cancel")!.addEventListener("click", () => dialog.close());
  form.addEventListener("submit", event => {
    event.preventDefault();
    applyColor(hsvToHex(hsv), opacity.valueAsNumber);
    dialog.close();
  });

  return (name: string, color: string, alpha: number, apply: typeof applyColor): void => {
    title.textContent = name;
    hsv = hexToHsv(color, 0);
    hex.value = color;
    hue.valueAsNumber = hsv.hue;
    slider.valueAsNumber = opacity.valueAsNumber = alpha;
    applyColor = apply;
    renderColor();
    dialog.showModal();
  };
}
