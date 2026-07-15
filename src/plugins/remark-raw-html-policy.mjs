import { visit } from "unist-util-visit";

/**
 * Article Markdown is content, not a general HTML execution surface. Keep raw
 * HTML readable by turning it into text before it reaches the HTML renderer.
 * Structured directives remain available for approved rich content.
 */
export function remarkRawHtmlPolicy() {
	return (tree, file) => {
		visit(tree, "html", (node) => {
			file.message("Raw HTML was rendered as text by the article safety policy", node, "remark-raw-html-policy");
			node.type = "text";
			delete node.data;
		});
	};
}
