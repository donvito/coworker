---
name: search-result-images
description: Show a few photos from web search results above a chat reply. Use whenever the user asks for images, pictures, or photos, or asks to see what something looks like, whatever the subject, including follow-ups about earlier results. Also use when the user is looking for, comparing, or choosing something they would judge by how it looks and a web search can supply photos of it, such as places to stay (Airbnb, hotel, or rental listings), event venues, restaurants, travel destinations, homes for sale, physical products, vehicles, artworks, landmarks, plants, or animals. Do not use, unless the user asked for pictures, for facts, news, prices, finance, software, documentation, how-to, or other research where pictures add nothing. Never use when the user wants text only; when the result is a file, an email, or a Telegram or Discord message; or to create, edit, or analyse images, including images the user attached.
---

# Search result images

Some answers are better with a look at the thing itself. This skill lets you show photos from a web search in your chat reply, either beside the items they belong to or as a small collage above the reply. You decide whether photos help and which ones to show. Unless the user asks for pictures, most searches should show none.

## Decide first

Show images when either is true, and the search returned images that actually depict what your reply talks about:

1. The user asked for them. See "When the user asks for images" below.
2. Seeing the subject would help the user judge, choose, or recognise it. Ask yourself whether a thoughtful person answering in a chat would paste photos here.

Unless the user asked for pictures, skip images and answer in text as usual when:

- The answer is information rather than a thing to look at: facts, explanations, news, numbers, schedules, code, policies, comparisons of specifications.
- The returned images are logos, icons, maps, charts, screenshots, banners with text, or unrelated stock photos. No images is better than weak images. Do not apologise for showing none.

Always skip images, even when asked, when:

- The user asked for text only, or told you earlier in the conversation to stop showing pictures.
- The request arrived from Telegram or Discord, or the result is going into a file or an email. The collage exists only in the desktop chat. If the user asked for pictures, say in one sentence that pictures only appear in the desktop chat.
- The subject is sensitive: injuries or medical conditions, violence, adult content, or a private individual. Describe it instead and, for medical subjects, link an authoritative source.
- The user wants an image generated, edited, or analysed rather than found on the web. That is not this skill.

See `references/examples.md` for worked decisions when a request is borderline.

## When the user asks for images

An explicit request is enough on its own, for any subject, including ones you would otherwise answer in text. Cues include "show me", "pictures of", "photos of", "images of", "what does it look like", "can I see", "with photos", and follow-ups such as "show me the second one".

- Search even if you could answer from memory: call `web.search` with `includeImages: true` and a query aimed at how the subject looks, for example `"Shibuya Crossing at night"` rather than `"Shibuya Crossing facts"`.
- Show what they asked for. If they asked for a logo, a diagram, a map, a chart, or a screenshot, that is a suitable image, not one to skip.
- If they asked for a number of images, show that many, up to 20. Otherwise pick 2 to 4, or 1 to 2 for a single subject.
- Answer the rest of the request as usual. A request for news with photos still gets the news, with sources.
- If the search returns nothing suitable, say so in one sentence and link the most relevant pages instead. Do not attach weak images just because they were asked for.
- For a follow-up about something you found earlier, search again with `includeImages: true` for that specific item.

## Get image candidates

Call `web.search` with `includeImages: true`, keeping the query as focused as you would for a text answer. The result then has an `images` list beside `results`. Each entry has:

- `url`: the image itself. Treat it as an opaque value.
- `title`: what the provider says the image shows.
- `sourceUrl`: the page it came from, when known. Match it to a `results[].url` to tell which listing or place a photo belongs to.
- `width` and `height`, when the provider reports them.

Image candidates exist only for the current request. For a follow-up such as "show me photos of the second one", search again with `includeImages: true`.

If you already searched without images and then decide photos would help, search once more with `includeImages: true` rather than guessing image addresses.

## Several photos of each option

When the user is choosing between options they would judge by how they look, such as places to stay, venues, homes, or products, a few photos of each option help more than one. A search for the whole set usually returns one photo per option at best, so look each option up on its own:

1. Find and choose the options first, as you would for a text answer. Keep to the 2 to 4 you will recommend.
2. For each option, call `web.search` with `includeImages: true` and a query naming that exact option, for example `"Uptown Parksuites BGC 2BR Airbnb"` or `"Herman Miller Aeron chair"`. Use `limit: 3`; you need its images, not more pages.
3. Keep up to 4 photos of that option: ones whose `sourceUrl` is the option's own page (a listing, a venue's site, the maker's product page, or a store's page for that exact product), or whose `title` clearly names it. A lookup often returns several images with the same `title` and `sourceUrl`: those are different photos from that page's gallery, such as the living room, a bedroom, and the view of a listing, or the front, side, and top of a product. They are not duplicates. Each distinct `url` is a distinct photo, so keep them all, up to 4. Treat images as duplicates only when their `url` is the same apart from size parameters.
   - The image's file name often says what it shows, for example `keyboard-3qtr-graphite.png` or `top-side-view.png`. Use it to tell product shots from images to skip: file names or titles with `feature`, `infographic`, `video`, `thumbnail`, `banner`, `size-chart`, `logo`, or `box` are usually not a photo of the product itself.
   - Another colour or switch option of the same product is a fine photo of it. A different model, generation, or size (an Air75 when you recommend the Air75 V2) is not.
4. Never put a photo of a different place or a lookalike product among an option's photos. One right photo is better than four mixed ones. If a lookup returns nothing you are sure of, show that option without photos.

Do this only when photos are part of the decision. Each lookup takes a search, so skip it for a single subject, for options chosen on other grounds, or when the user wants a quick answer. If the user asks for "more photos" of one option, do a lookup for that option alone.

## Choose

- After per-option lookups, attach every distinct photo of each option the lookup found, up to 4 per option. Do not cut an option down to one photo when its lookup returned more.
- Without per-option lookups, pick 2 to 4 images for a set of options, preferring one photo per option over several of the same one, and 1 for a single subject.
- Never more than 20 in a reply. When the user asked for a specific number, follow "When the user asks for images".
- Every image must show something you name in the reply.
- Prefer real photographs of the subject: the room, the building, the dish, the product. Prefer larger images (around 400 pixels wide or more) and avoid near-duplicates.
- Judge by `title` and `sourceUrl`; you cannot see the picture. If you cannot tell what an image shows, leave it out.
- Put them in the order your reply mentions the items.

## Attach, then answer

Call `chat.attach_images` once with every photo you chose, grouped by option in the order your reply lists the options, before you write the reply:

```json
{
  "images": [
    { "url": "<images[].url exactly as returned>", "alt": "Beachfront one-bedroom villa with pool, Seminyak" }
  ]
}
```

- Copy each `url` character for character. The app accepts only image addresses that a tool returned during this request and rejects anything edited, shortened, or invented.
- Write `alt` as a short factual caption: what and where, taken from the title and source page. Do not describe details you cannot verify.
- Check the result. `attached` is how many will be shown; `rejected` lists any that were refused and why. Each attached image has a `ref` such as `image:1`.

Then write the reply as you normally would, with the source links the web search skill asks for.

## Place each photo beside its item

When the reply lists options and a photo belongs to one of them, put the photo next to that option so the user sees them together. Write `![short caption](image:1)` with the image's `ref` where the photo should appear:

- In a table, make the first column `Photo` and put one image per row. Leave the cell empty for an option without a photo.

  ```markdown
  | Photo | Listing | Details |
  | --- | --- | --- |
  | ![Living room](image:1) | [Uptown BGC 2BR Luxe Suite](https://...) | 2BR near High Street, pool access |
  | | [Aura Suites BGC](https://...) | Studio-style, corporate center area |
  ```

- In a list, start the item with its photos: `- ![Living room](image:1) ![Pool deck](image:2) **[Name](https://...)**: details`. The photos sit to the left of the item's text.
- For several photos of one option, write their refs next to each other, separated only by spaces. They show as a small collage of that option, and clicking one opens a viewer with just that option's photos. The first ref is the cover, so put the best overall photo first.

  ```markdown
  | Photos | Listing | Details |
  | --- | --- | --- |
  | ![Living room](image:1) ![Pool deck](image:2) ![Bedroom](image:3) | [Uptown BGC 2BR Luxe Suite](https://...) | 2BR near High Street, pool access |
  | ![Studio](image:4) ![Gym](image:5) | [Aura Suites BGC](https://...) | Studio-style, corporate center area |
  ```

- Keep different options' refs apart: never write two options' photos side by side.
- Use each ref once, only for the item the image shows, and copy it exactly from the tool result.

Images you do not place are shown as a collage above the reply. Leave them there when the photos are of one subject or do not belong to a particular item, such as several views of one landmark.

Whichever way you show them:

- Use only `image:N` refs in Markdown image syntax. Never paste image URLs into the reply.
- Do not announce the images ("Here are some photos"). Mention an image only where it helps, for example to say which option a photo belongs to.
- Do not claim the photos prove anything about availability, price, or condition.

## When it does not work

- No suitable images, or `images` is empty: answer in text. Do not search again only to find pictures unless the user asked to see them. If they did, one more focused search is reasonable; if that also fails, say so briefly.
- `chat.attach_images` is refused or fails: fix the cause once if it is clear (for example, an altered URL), otherwise carry on with the text answer. Never tell the user images are shown unless the tool reported them attached.
- An image may still fail to load on the user's screen. The reply must make sense without it, so never put information only in a caption.
