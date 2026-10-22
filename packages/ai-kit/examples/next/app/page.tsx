"use client";
import { AiManager, TextGenerationExample } from "ai-kit/react";
import { businessCallbacks, managerCallbacks } from "../lib/client";
/** Place management inside the host's existing admin route; its backend independently enforces authorization. */
export default function Page() {
  return (
    <main>
      <AiManager {...managerCallbacks} />
      <TextGenerationExample {...businessCallbacks} />
    </main>
  );
}
