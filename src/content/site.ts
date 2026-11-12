/**
 * The site's own words: navigation, home and about copy.
 *
 * Edit freely. The site's NAME and LOGO are not here: they come from the
 * platform (`GET /site-api/site`), so a rename in the dashboard shows
 * up without a Publish. Use `{name}` in any string below for the site name.
 */

/** Search and social basics. The NAME comes from the platform (above). */
export const SITE = {
  /** One sentence: the meta description of pages that have none of their own. Use `{name}`. */
  description: 'Answers, guides and help from the {name} team: search the help center, ask the assistant or reach a person.',
  /** `en`, `fr`, … : the page language (screen readers, search engines). */
  lang: 'en',
  /**
   * The address search engines should treat as THE address (canonical URLs,
   * sitemap, social cards): set it to the custom domain once the owner has one
   * (`https://www.example.com`, no trailing slash). Empty = the address
   * The platform gives the site (`SITE_URL`, src/lib/seo.ts).
   */
  url: '',
};

export interface NavItem {
  label: string;
  href: string;
  /**
   * `false` for a page rendered on every visit (SSR): it is
   * private (`no-store`), so fetching it ahead would be wasted. Every other
   * item is prerendered and prefetched as soon as the nav is on screen.
   */
  prefetch?: false;
}

/**
 * Top navigation. Every href is a page of THIS site (`/`, `/help/`, `/blog/`,
 * `/about/`, `/dashboard`, `/account/…`): plain links.
 */
export const NAV: NavItem[] = [
  {label: 'Home', href: '/'},
  // The help center's home is rendered on every visit (SSR): no prefetch.
  {label: 'Help', href: '/help/', prefetch: false},
  {label: 'Blog', href: '/blog/'},
  {label: 'About', href: '/about/'},
];

/**
 * The home page, top to bottom (`src/pages/index.astro`). Each block is one
 * section; reorder or drop freely. Rewrite every word for the business. Use
 * `{name}` for the site name. No invented reviews or numbers.
 *
 * The categories and popular articles are NOT here: the help center's own
 * content (`/site-api/kb/home`) fills them in the browser.
 */
export const HOME = {
  hero: {
    eyebrow: '{name} help center',
    title: 'Get answers fast',
    body: 'Search our guides, ask the assistant, or reach a person on the team.',
    /** The search box: a visible label, an example, the button. */
    label: 'Search the help center',
    placeholder: 'For example: change my password',
    button: 'Search',
    /** Shown under the box when the search is too short (the server ignores under 2 characters). */
    tooShort: 'Type at least 2 characters to search.',
    /** The row of category links under the box (filled from the help center). */
    topics: 'Popular topics:',
    browse: 'Browse the help center',
  },
  popular: {title: 'Popular articles', link: 'All topics'},
  how: {
    eyebrow: 'How it works',
    title: 'Help in three steps',
    /** `icon`: one of the names in `src/components/home/Icon.astro`. */
    steps: [
      {icon: 'search', title: 'Search the help center', body: 'Type your question in a few words. Most answers are one search away.'},
      {icon: 'message', title: 'Ask the assistant', body: 'Ask in your own words. It answers from our articles and shows where each answer comes from.'},
      {icon: 'headset', title: 'Talk to a person', body: 'Still stuck? Ask for a person and someone from the team picks it up.'},
    ],
  },
  blog: {title: 'Latest from the blog', link: 'All posts'},
  faq: {
    eyebrow: 'Questions',
    title: 'About getting help',
    items: [
      {
        q: 'Where do the answers come from?',
        a: 'From the articles in our help center, written and kept up to date by our team.',
      },
      {
        q: 'Can I trust the assistant?',
        a: 'It answers only from our help center and lists the articles it used, so you can check. It can be wrong: when it is not sure, it says so and offers you a person.',
      },
      {
        q: 'Can I talk to a person?',
        a: 'Yes. If the articles and the assistant do not solve it, ask for a person and someone from the team takes it from there.',
      },
      {
        q: 'Do I need an account?',
        a: 'No. The help center is open to everyone, with no sign-in needed.',
      },
    ],
  },
  cta: {
    title: 'Still looking for something?',
    body: 'Every topic and article is in the help center, open around the clock.',
    primary: 'Browse the help center',
    secondary: 'Read the blog',
  },
};

export const ABOUT = {
  title: 'About {name}',
  lede: 'Who we are, and why we do this.',
  sections: [
    {
      heading: 'Our story',
      body: '{name} started with a simple idea: good things are easier together. Replace this text with your own story.',
    },
    {
      heading: 'What you will find here',
      body: 'A help center with answers to common questions, an assistant that answers from it, a person when you need one, and a blog with practical guides.',
    },
    {
      heading: 'How to get help',
      body: 'Search the help center or read the blog. Everyone is welcome.',
    },
  ],
};

/** Fill `{name}` with the site's name. */
export function withName(text: string, name: string): string {
  return text.replaceAll('{name}', name);
}
