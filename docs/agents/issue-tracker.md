# Issue tracker: Local Markdown

Issues and specs for this repository live as Markdown files in `.scratch/`.

## Conventions

- One feature per directory: `.scratch/<feature-slug>/`
- The feature spec is `.scratch/<feature-slug>/spec.md`.
- Implementation issues are individual files under `.scratch/<feature-slug>/issues/`, numbered from `01`.
- Each issue records its triage state in a `Status:` line near the top.
- Comments and conversation history are appended under a `## Comments` heading.

When a skill says to publish to the issue tracker, create the requested files under the relevant `.scratch/<feature-slug>/` directory. When it says to fetch a ticket, read the referenced Markdown file.
