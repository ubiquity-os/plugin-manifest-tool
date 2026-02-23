# `@ubiquity/ts-template`

This template repository includes support for the following:

- TypeScript
- Environment Variables
- Conventional Commits
- Automatic deployment to Cloudflare Pages

## Testing

### Cypress

To test with Cypress Studio UI, run

```shell
bun run cy:open
```

Otherwise, to simply run the tests through the console, run

```shell
bun run cy:run
```

### Jest

To start Jest tests, run

```shell
bun run test
```

## Sync any repository to latest `ts-template`

A bash function that can do this for you:

```bash
#!/bin/bash
# shellcheck shell=bash

get-ts-template() {
  local branch_name
  branch_name=$(git rev-parse --abbrev-ref HEAD)

  # Check if we're in detached HEAD state
  if [ "$branch_name" = "HEAD" ]; then
    echo "Error: You are in a detached HEAD state. Please checkout a branch first."
    return 1
  fi

  # Create new branch for template merge
  local merge_branch="chore/merge-${branch_name}-template"

  # Check if template remote already exists
  if git remote | grep -q "^template$"; then
    echo "Template remote already exists, removing it first..."
    git remote remove template
  fi

  echo "Adding template remote..."
  git remote add template https://github.com/ubiquity/ts-template

  echo "Fetching from template..."
  if ! git fetch template development; then
    echo "Error: Failed to fetch from template"
    git remote remove template
    return 1
  fi

  echo "Setting up merge branch: ${merge_branch}"
  # If branch exists, delete it
  if git show-ref --verify --quiet "refs/heads/${merge_branch}"; then
    echo "Branch ${merge_branch} already exists, deleting it..."
    git checkout "$branch_name"
    git branch -D "${merge_branch}"
  fi

  # Create and checkout new branch
  if ! git checkout -b "${merge_branch}"; then
    echo "Error: Failed to create merge branch"
    git remote remove template
    return 1
  fi

  echo "Merging template changes with strategy: theirs"
  if ! git merge -X theirs template/development --no-commit --allow-unrelated-histories; then
    echo "Error: Merge failed"
    git merge --abort
    git checkout "$branch_name"
    git branch -D "${merge_branch}"
    git remote remove template
    return 1
  fi

  echo "Staging all changes for review..."
  git add .

  echo "Success! All template changes have been merged and staged."
  echo "You can now review the changes in VSCode."
  echo "To apply the changes: git commit -m 'chore: merge template updates'"
  echo "To undo: git reset --hard HEAD"
  echo "To abort completely: git checkout $branch_name && git branch -D $merge_branch"

  # Cleanup
  git remote remove template
}
```
