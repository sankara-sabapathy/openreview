/** @type {import('@docusaurus/plugin-content-docs').SidebarsConfig} */
const sidebars = {
  docs: {
    Docs: [
      "intro",
      "quickstart",
      "configuration",
      "templates",
      {
        type: "category",
        label: "Providers",
        link: { type: "doc", id: "providers/index" },
        items: [
          "providers/claude",
          "providers/openai",
          "providers/opencode-go",
          "providers/opencode-zen",
          "providers/custom",
        ],
      },
      "multi-review",
      "self-hosted",
      "versioning",
      "troubleshooting",
    ],
  },
};
export default sidebars;
