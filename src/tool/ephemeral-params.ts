import { Type } from "@sinclair/typebox";

export const ephemeralParamShape = {
  tools: Type.Optional(
    Type.Array(Type.String(), {
      description:
        'One-off agent only. Tools the agent may use: "*" for every built-in tool, "none" for none, built-in tool names, and "ext:<extension>" or "ext:<extension>/<tool>" to select extension tools. Default: every built-in tool and every extension tool.',
    }),
  ),
  disallowed_tools: Type.Optional(
    Type.Array(Type.String(), { description: "One-off agent only. Tool names to remove from the agent, whether built-in or from an extension." }),
  ),
  extensions: Type.Optional(
    Type.Union([Type.Boolean(), Type.Array(Type.String())], {
      description: "One-off agent only. true loads every extension, false loads none, and a list loads only the named extensions. Default: true.",
    }),
  ),
  exclude_extensions: Type.Optional(
    Type.Array(Type.String(), { description: "One-off agent only. Extension names to leave out. Wins over extensions." }),
  ),
  skills: Type.Optional(
    Type.Union([Type.Boolean(), Type.Array(Type.String())], {
      description: "One-off agent only. true makes every skill available, false none, and a list preloads the named skills. Default: true.",
    }),
  ),
  allowed_subagents: Type.Optional(
    Type.Union([Type.Literal("all"), Type.Array(Type.String())], {
      description: 'One-off agent only. Agent types this agent may start itself: "all" or a list. [] means no nesting. Default: [].',
    }),
  ),
  prompt_mode: Type.Optional(
    Type.Union([Type.Literal("append"), Type.Literal("replace")], {
      description:
        'One-off agent only. "append" keeps this session\'s system prompt, so the agent follows the project\'s conventions. "replace" gives it only a short sub-agent preamble and an environment block. Default: "append".',
    }),
  ),
};
