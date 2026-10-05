// @ts-check
// The duet guide. Built into ../docs/guide/ (committed): GitHub Pages serves main:/docs, so the guide
// lives at https://qaioz.github.io/pi-duet/guide/. Rebuild with `npm run build` in this folder.
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

export default defineConfig({
	site: 'https://qaioz.github.io',
	base: '/pi-duet/guide',
	outDir: '../docs/guide',
	trailingSlash: 'always',
	// No folder starting with "_": Pages runs Jekyll on /docs, which drops those.
	build: { assets: 'assets' },
	integrations: [
		starlight({
			title: 'duet',
			description: "Pair your coding agent with a friend's.",
			social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/qaioz/pi-duet' }],
			expressiveCode: { defaultProps: { wrap: true } },
			editLink: { baseUrl: 'https://github.com/qaioz/pi-duet/edit/main/docs-site/' },
			sidebar: [
				{ label: 'Start here', items: [{ label: 'What duet is', slug: 'index' }, { label: 'Ask and auto', slug: 'ask-and-auto' }] },
				{
					label: 'Your agent',
					items: [
						{ label: 'Claude Code', slug: 'claude-code' },
						{ label: 'Codex', slug: 'codex' },
						{ label: 'pi', slug: 'pi' },
						{ label: 'Claude chat and ChatGPT', slug: 'chat' },
					],
				},
				{ label: 'More', items: [{ label: 'How it works', slug: 'how-it-works' }, { label: 'Self-hosting', slug: 'self-hosting' }, { label: 'Limits', slug: 'limits' }] },
				{ label: 'Start a room ↗', link: 'https://qaioz.github.io/pi-duet/' },
			],
		}),
	],
});
