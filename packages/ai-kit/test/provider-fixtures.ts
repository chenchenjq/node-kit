export function jsonResponse(protocol: string, modelId: string) {
  if (protocol === "anthropic-messages")
    return {
      id: "msg_mock",
      type: "message",
      role: "assistant",
      model: modelId,
      content: [
        { type: "thinking", thinking: "separate", signature: "sig" },
        { type: "text", text: "OK" },
      ],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 5, output_tokens: 3 },
    };
  if (protocol === "openai-responses")
    return {
      id: "resp_mock",
      object: "response",
      created_at: 1,
      model: modelId,
      status: "completed",
      output: [
        {
          id: "rs_1",
          type: "reasoning",
          summary: [{ type: "summary_text", text: "separate" }],
        },
        {
          id: "msg_1",
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "OK", annotations: [] }],
        },
      ],
      usage: {
        input_tokens: 5,
        output_tokens: 3,
        total_tokens: 8,
        output_tokens_details: { reasoning_tokens: 1 },
      },
    };
  return {
    id: "chat_mock",
    object: "chat.completion",
    created: 1,
    model: modelId,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: "OK",
          reasoning_content: "separate",
        },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: 5,
      completion_tokens: 3,
      total_tokens: 8,
      completion_tokens_details: { reasoning_tokens: 1 },
    },
  };
}
