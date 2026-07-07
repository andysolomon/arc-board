# GitHub Issue Planning Mode

Load this when the source work item is a GitHub issue.

## Read source

```bash
gh issue view <number> --json title,body,labels,comments
```

Read referenced files and related code before drafting the plan.

## Publish plan

Prefer writing the plan to a temp file and using `--body-file` for long markdown.

```bash
cat > /tmp/issue-plan.md << 'PLAN_EOF'
## Implementation Plan
...
PLAN_EOF

gh issue comment <number> --body-file /tmp/issue-plan.md
```

## Branch naming

```bash
git checkout -b feat/W-XXXXXX-short-description
```

If there is no `W-` ID, use:

```bash
git checkout -b feat/issue-<number>-short-description
```

## Project status

If a project board is configured, move the issue to In Progress only after the plan is posted.

```bash
gh project item-list <project-number> --owner <owner> --format json \
  --jq '.items[] | select(.content.number == <issue-number>)'
```

## PR convention

When implementing later, PR bodies should include:

```text
Closes #<number>
```

This planning skill should not create the PR or start coding.
