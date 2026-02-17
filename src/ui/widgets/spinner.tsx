import { useEffect, useState } from "react";

const FRAMES = {
  dots: ["⠋", "⠙", "⠸", "⠴", "⠦", "⠇"],
  line: ["-", "\\", "|", "/"],
} as const;

type SpinnerType = keyof typeof FRAMES;

interface SpinnerProps {
  type?: SpinnerType;
}

export default function Spinner({ type = "dots" }: SpinnerProps) {
  const frames = FRAMES[type];
  const safeFrames: readonly string[] = frames.length > 0 ? frames : ["."];
  const [index, setIndex] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setIndex((prev) => (prev + 1) % safeFrames.length);
    }, 90);
    return () => clearInterval(timer);
  }, [safeFrames.length]);

  return safeFrames[index] ?? ".";
}
