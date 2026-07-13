import { getSortedPosts } from "@/utils/content-utils";
import { toArticleDate } from "@/utils/date-utils";

export async function GET() {
	const posts = await getSortedPosts();

	const allPostsData = posts
		.map((post) => ({
			id: post.id,
			title: post.data.title,
			description: post.data.description,
			published: toArticleDate(post.data.published).getTime(),
			category: post.data.category || "",
			password: !!post.data.password,
		}))
		// 日历按纯日期排序，忽略置顶

	return new Response(JSON.stringify(allPostsData));
}
