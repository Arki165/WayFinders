import { useState } from "react";

// Полоска, за которую тянут край панели.
// dir "x" - левый край правой панели, "y" - верхний край нижней панели.
// В обоих случаях панель растет, когда тянем к центру карты.
type Props = {
  dir: "x" | "y";
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
};

export default function Resizer({ dir, value, min, max, onChange }: Props) {
  const [drag, setDrag] = useState(false);

  function onMouseDown(e: React.MouseEvent) {
    e.preventDefault();
    const start = dir === "x" ? e.clientX : e.clientY;
    const startValue = value;
    setDrag(true);
    // пока тянем, курсор не меняется над картой и текст не выделяется
    document.body.style.cursor = dir === "x" ? "col-resize" : "row-resize";
    document.body.style.userSelect = "none";

    function onMove(ev: MouseEvent) {
      const now = dir === "x" ? ev.clientX : ev.clientY;
      const next = startValue + (start - now);
      onChange(Math.min(max, Math.max(min, next)));
    }

    function onUp() {
      setDrag(false);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    }

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  return (
    <div
      className={"resizer " + dir + (drag ? " drag" : "")}
      onMouseDown={onMouseDown}
      title="Потяните, чтобы изменить размер"
    />
  );
}
