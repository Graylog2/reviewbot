/**
 * @param {import('probot').Probot} app
 */
import type { Probot } from 'probot';
import * as core from '@actions/core';
import * as fs from 'fs';
import { spawnSync } from 'child_process';
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

// execution timeout in milliseconds
const LINTER_TIMEOUT = 10 * 60 * 1000;

async function exec(command: string) {
  return new Promise<string>((resolve, reject) => {
    const result = spawnSync(command, { timeout: LINTER_TIMEOUT });
    if (result.status === 0) {
      resolve(result.stdout.toString());
    } else {
      reject(result.error);
    }
  });
}

async function lintDiff(
  baseSha: string,
  headSha: string,
  prefix: string,
  workingDirectory: string
): Promise<Array<File>> {
  const cmd = `cd ./${workingDirectory}/${prefix}; git diff --name-only --diff-filter=ACMR ${baseSha}...${headSha} | grep -E '^${prefix}/(.*).[jt]s(x)?$'|sed 's,^${prefix}/,,'|xargs yarn -s eslint -f json`;
  core.debug(`Executing: ${cmd}`);
  const result = await exec(cmd);
  core.debug(`Got result: ${result}`);
  return JSON.parse(result) as Array<File>;
}

const normalizeFilename = (filename: string, workingDirectory: string) =>
  path.relative(`${process.cwd()}/${workingDirectory}`, filename);

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

const writeSummary = (summary: string) => {
  const filename = process.env.GITHUB_STEP_SUMMARY;

  if (filename === undefined) {
    throw Error('No step summary filename passed in environment!');
  }

  fs.writeFileSync(filename, summary);
};

const worriedEmoji = (numberOfErrors: number) => {
  if (numberOfErrors > 100) {
    return ':sob:';
  }

  if (numberOfErrors > 10) {
    return ':disappointed_relieved:';
  }

  return ':worried:';
};

export default (app: Probot) => {
  app.on(['pull_request.opened', 'pull_request.synchronize'], async (context) => {
    const prefix = core.getInput('prefix', { required: true });
    const workingDirectory = core.getInput('workingDirectory', { required: false }) ?? '.';
    const { owner, repo, pull_number } = await context.pullRequest();

    core.debug(`Started for PR ${pull_number} in repo ${repo} from ${owner}.`);

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

    core.debug(`Base SHA: ${baseSha}, head SHA: ${headSha}`);

    if (shouldBeSkipped(body)) {
      core.debug('Skipping PR.');
      return;
    }

    const results = await lintDiff(baseSha, headSha, prefix, workingDirectory);
    const filesWithErrors = results.filter((result) => result.messages.length > 0);

    core.debug(`Files with errors: ${JSON.stringify(filesWithErrors, null, 2)}`);

    const totalErrors = filesWithErrors.map((file) => file.messages.length).reduce((prev, cur) => prev + cur, 0);

    if (totalErrors > 0) {
      const annotations = filesWithErrors.flatMap((file) =>
        file.messages.map((message) => ({
          message: formatRuleMessage(message.ruleId),
          title: message.message,
          file: normalizeFilename(file.filePath, workingDirectory),
          startLine: message.line,
          startColumn: message.column,
          endLine: message.endLine,
          endColumn: message.endColumn,
        }))
      );

      annotations.forEach(({ message, ...rest }) => core.warning(message, rest));

      core.setFailed(`Found ${totalErrors} linter hints in the changed code.`);

      writeSummary(`## Found ${totalErrors} linter hints in the changed code. ${worriedEmoji(totalErrors)}`);
    } else {
      writeSummary('## Your code looks awesome! :rocket:');
    }
  });
};
