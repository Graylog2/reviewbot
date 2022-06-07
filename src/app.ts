/**
 * @param {import('probot').Probot} app
 */
import type { Probot } from 'probot';
import * as core from '@actions/core';
import { exec as childExec } from 'child_process';
import path from 'path';

type Message = {
  ruleId: string;
  severity: number;
  message: string;
  line: number;
  column: number;
  nodeType: string;
  messageId: string;
  endLine: number;
  endColumn: number;
};
type File = {
  filePath: string;
  messages: Array<Message>;
};

async function exec(command: string) {
  return new Promise<string>((resolve) => childExec(command, (error, stdout, stderr) => resolve(stdout)));
}

async function lintDiff(baseSha: string, headSha: string, prefix: string): Promise<Array<File>> {
  const cmd = `cd ./${prefix}; git diff --name-only --diff-filter=ACMR ${baseSha}..${headSha} | grep -E '^${prefix}/(.*).[jt]s(x)?$'|sed 's,^${prefix}/,,'|xargs yarn -s eslint -f json`;
  const result = await exec(cmd);
  return JSON.parse(result) as Array<File>;
}

const normalizeFilename = (filename: string) => path.relative(process.cwd(), filename);

const ruleUrl = (ruleName: string) => {
  const splittedRuleName = ruleName.split('/');
  if (splittedRuleName.length === 1) {
    return `https://eslint.org/docs/rules/${ruleName}`;
  }

  const [domain, ruleId] = splittedRuleName;
  switch (domain) {
    case 'jest':
      return `https://github.com/jest-community/eslint-plugin-jest/blob/main/docs/rules/${ruleId}.md`;
    case 'testing-library':
      return `https://github.com/testing-library/eslint-plugin-testing-library/blob/main/docs/rules/${ruleId}.md`;
    case '@typescript-eslint':
      return `https://github.com/typescript-eslint/typescript-eslint/blob/main/packages/eslint-plugin/docs/rules/${ruleId}.md`;
  }

  return undefined;
};

const formatRuleMessage = (ruleName: string) => {
  const url = ruleUrl(ruleName);

  return url ? `See ${url} for details.` : 'No further rule information available.';
};

const shouldBeSkipped = (body: string | null) =>
  body ? body.includes('[review skip]') || body.includes('[no review]') || body.includes('[skip review]') : false;

export default (app: Probot) => {
  app.on(['pull_request.opened', 'pull_request.synchronize'], async (context) => {
    const prefix = core.getInput('prefix', { required: true });
    const { owner, repo, pull_number } = await context.pullRequest();
    const {
      data: {
        body,
        base: { sha: baseSha },
        head: { sha: headSha },
      },
    } = await context.octokit.pulls.get({
      owner,
      repo,
      pull_number,
    });

    if (shouldBeSkipped(body)) {
      return;
    }

    const results = await lintDiff(baseSha, headSha, prefix);
    const filesWithErrors = results.filter((result) => result.messages.length > 0);
    const totalErrors = filesWithErrors.map((file) => file.messages.length).reduce((prev, cur) => prev + cur, 0);

    if (totalErrors > 0) {
      const annotations = filesWithErrors.flatMap((file) =>
        file.messages.map((message) => ({
          message: formatRuleMessage(message.ruleId),
          title: message.message,
          file: normalizeFilename(file.filePath),
          startLine: message.line,
          startColumn: message.column,
          endLine: message.endLine,
          endColumn: message.endColumn,
        }))
      );

      annotations.forEach(({ message, ...rest }) => core.warning(message, rest));

      core.setFailed(`Found ${totalErrors} linter hints in the changed code.`);
    }
  });
};
