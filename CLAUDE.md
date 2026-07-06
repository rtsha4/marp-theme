# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview
This is a custom Marp theme repository. Marp is a markdown presentation ecosystem that allows creating slide decks from markdown files.

## Repository Structure
```
marp-theme/
├── themes/
│   └── azulite.css         # Main theme CSS file
├── sample-slide.md         # Example presentation
├── package.json            # Dependencies and scripts
└── README.md              # Project documentation
```

## Development Commands
- `bun install`: Install dependencies (always use bun as package manager)
- `bun run build`: Build presentation to HTML
- `bun run serve`: Start development server with live reload
- `bun run watch`: Watch for changes and rebuild automatically

## Theme Development
- Main theme file: `themes/azulite.css`
- Uses CSS custom properties for consistent styling
- Supports multiple slide layouts: title, section, columns, align-center
- Color classes available: text-blue, text-red, text-gray

## Creating Presentations
- Use `sample-slide.md` as a template
- Set theme in frontmatter: `theme: azulite`
- Available slide classes: title, section, columns, align-center
- Supports standard Markdown with enhanced styling