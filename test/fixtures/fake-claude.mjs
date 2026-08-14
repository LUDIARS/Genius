const args = process.argv.slice(2);

if (args.includes("--version")) {
  process.stdout.write("fake-claude 1.0.0\n");
  process.exit(0);
}

if (args.includes("--fail-with-stderr")) {
  process.stderr.write("simulated private CLI diagnostic\n");
  process.exit(1);
}

let prompt = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) prompt += chunk;
const systemPromptIndex = args.indexOf("--system-prompt");
const systemPrompt = systemPromptIndex < 0 ? undefined : args[systemPromptIndex + 1];
if (
  !args.includes("-p")
  || !args.includes("--model")
  || typeof systemPrompt !== "string"
  || systemPrompt.trim() === ""
  || prompt.trim() === ""
) {
  process.stderr.write("invalid fake Claude invocation\n");
  process.exit(2);
}
process.stdout.write(
  args.includes("--echo-request")
    ? JSON.stringify({ systemPrompt, prompt })
    : '{"ok":true}',
);
