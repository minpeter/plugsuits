# Consumer Archetypes

`plugsuits`를 사용하여 에이전트를 구축할 때 참고할 수 있는 3가지 주요 아키타입(Archetype)과 예시 코드입니다.

## 1. CLI / TUI Archetype (Interactive)

사용자와 터미널에서 실시간으로 대화하고 파일을 수정하는 도구에 적합합니다. `@ai-sdk-tool/cea` 패키지의 인터랙션 로직을 함께 사용하는 것이 좋습니다.

**추천 패키지:** `@ai-sdk-tool/harness`, `@ai-sdk-tool/cea`

```typescript
import { createMemoryAgent, runAgentLoop } from "@ai-sdk-tool/harness";
import { anthropic } from "@ai-sdk/anthropic";

const { agent } = createMemoryAgent({
  model: anthropic("claude-3-5-sonnet-latest"),
  instructions: "You are a helpful CLI assistant.",
  tools: {
    // CEA에서 제공하는 도구들 추가 가능
  }
});

await runAgentLoop({
  agent,
  messages: [{ role: "user", content: "hello" }],
  onToolCall: (call) => console.log(`Executing tool: ${call.toolName}`),
  onStepComplete: (step) => {
    const lastMsg = step.messages[step.messages.length - 1];
    if (lastMsg.role === "assistant") {
      console.log(lastMsg.content);
    }
  }
});
```

## 2. Bot / Webhook Archetype

텔레그램, 슬랙 등 외부 메시징 플랫폼과 연동되는 무상태(Stateless) 에이전트에 적합합니다. `SessionStore`를 통해 대화 기록을 영속화합니다.

**추천 패키지:** `@ai-sdk-tool/harness`

```typescript
import { createSessionAgent, SessionStore } from "@ai-sdk-tool/harness";

const store = new SessionStore("./sessions");

// Webhook 핸들러 내부
async function handleMessage(userId: string, text: string) {
  const { agent, history, save } = await createSessionAgent({
    model: myModel,
    store,
    sessionId: userId,
  });

  history.addUserMessage(text);
  const result = await agent.stream({
    messages: history.getMessagesForLLM(),
  });

  const response = await result.response;
  history.addModelMessages(response.messages);
  await save();
}
```

## 3. Server-Worker Archetype (Headless)

장시간 실행되는 복잡한 작업(예: 자율적인 코드 수정, 리서치)을 수행하고, 실행 과정을 기록(Trajectory)해야 하는 서버 애플리케이션에 적합합니다.

**추천 패키지:** `@ai-sdk-tool/headless`

```typescript
import { runHeadless } from "@ai-sdk-tool/headless";
import { createMemoryAgent } from "@ai-sdk-tool/harness";

const { agent, history } = createMemoryAgent({ model: myModel });

const events = await runHeadless({
  agent,
  messageHistory: history,
  sessionId: "task-123",
  initialUserMessage: { content: "Refactor the authentication module." },
  atifOutputPath: "./trajectories/task-123.jsonl",
  emitEvent: (event) => {
    // 실시간 대시보드 업데이트나 로깅
    if (event.type === "step" && event.source === "agent") {
      console.log(`Agent working: ${event.message}`);
    }
  }
});
```
