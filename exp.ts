import { renderChatPrompt } from "./src/context/chat-render";

const rendered = await renderChatPrompt({
  model: "LGAI-EXAONE/EXAONE-4.0.1-32B",
  instructions: "You are a helpful assistant.",
  tools: {},
  messages: [{ role: "user", content: "What is the capital of France?" }],
});

console.log(rendered);
