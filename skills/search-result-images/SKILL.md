---
name: search-result-images
description: Show a few photos from web search results above a chat reply. Use when the user is looking for, comparing, or choosing something they would judge by how it looks and a web search can supply photos of it, such as places to stay (Airbnb, hotel, or rental listings), event venues, restaurants, travel destinations, homes for sale, physical products, vehicles, artworks, landmarks, plants, or animals, or when the user asks to see pictures of something found on the web. Do not use for facts, news, prices, finance, software, documentation, how-to, or other research where pictures add nothing; when the user wants text only; when the result is a file, an email, or a Telegram or Discord message; or to create, edit, or analyse images, including images the user attached.
---

# Search result images

Some answers are better with a look at the thing itself. This skill lets you put a small photo collage above your chat reply, using images that a web search returned. You decide whether photos help and which ones to show. Most searches should show none.

## Decide first

Show images only when both are true:

1. Seeing the subject would help the user judge, choose, or recognise it. Ask yourself whether a thoughtful person answering in a chat would paste photos here.
2. The search returned photos that actually depict the specific things your reply talks about.

Skip images, and answer in text as usual, when:

- The answer is information rather than a thing to look at: facts, explanations, news, numbers, schedules, code, policies, comparisons of specifications.
- The user asked for text only, a quick fact, or told you earlier in the conversation to stop showing pictures.
- The request arrived from Telegram or Discord, or the result is going into a file or an email. The collage exists only in the desktop chat.
- The subject is sensitive: injuries or medical conditions, violence, adult content, or a private individual.
- The returned images are logos, icons, maps, charts, screenshots, banners with text, or unrelated stock photos. No images is better than weak images. Do not apologise for showing none.

An explicit request to see something ("show me what it looks like") is a reason to show images, if a search returns suitable ones.

See `references/examples.md` for worked decisions when a request is borderline.

## Get image candidates

Call `web.search` with `includeImages: true`, keeping the query as focused as you would for a text answer. The result then has an `images` list beside `results`. Each entry has:

- `url`: the image itself. Treat it as an opaque value.
- `title`: what the provider says the image shows.
- `sourceUrl`: the page it came from, when known. Match it to a `results[].url` to tell which listing or place a photo belongs to.
- `width` and `height`, when the provider reports them.

Image candidates exist only for the current request. For a follow-up such as "show me photos of the second one", search again with `includeImages: true`.

If you already searched without images and then decide photos would help, search once more with `includeImages: true` rather than guessing image addresses.

## Choose

- Pick 2 to 4 images for a set of options; 1 for a single subject; never more than 6.
- Every image must show something you name in the reply. Prefer one photo per recommended option over several of the same option.
- Prefer real photographs of the subject: the room, the building, the dish, the product. Prefer larger images (around 400 pixels wide or more) and avoid near-duplicates.
- Judge by `title` and `sourceUrl`; you cannot see the picture. If you cannot tell what an image shows, leave it out.
- Put them in the order your reply mentions the items.

## Attach, then answer

Call `chat.attach_images` once, before you write the reply:

```json
{
  "images": [
    { "url": "<images[].url exactly as returned>", "alt": "Beachfront one-bedroom villa with pool, Seminyak" }
  ]
}
```

- Copy each `url` character for character. The app accepts only image addresses that a tool returned during this request and rejects anything edited, shortened, or invented.
- Write `alt` as a short factual caption: what and where, taken from the title and source page. Do not describe details you cannot verify.
- Check the result. `attached` is how many will be shown; `rejected` lists any that were refused and why.

Then write the reply as you normally would, with the source links the web search skill asks for. The images appear above it automatically, so:

- Do not paste image URLs or use Markdown image syntax in the reply.
- Do not announce the images ("Here are some photos"). Mention an image only where it helps, for example to say which option a photo belongs to.
- Do not claim the photos prove anything about availability, price, or condition.

## When it does not work

- No suitable images, or `images` is empty: answer in text. Do not search again only to find pictures unless the user asked to see them.
- `chat.attach_images` is refused or fails: fix the cause once if it is clear (for example, an altered URL), otherwise carry on with the text answer. Never tell the user images are shown unless the tool reported them attached.
- An image may still fail to load on the user's screen. The reply must make sense without it.
