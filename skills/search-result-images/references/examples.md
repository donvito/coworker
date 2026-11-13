# Worked decisions

Use these to calibrate, not as a lookup table. The question is always whether seeing the subject helps the user and whether the search returned photos of it.

## Show images

| Request | Why | What to pick |
| --- | --- | --- |
| "Find me an Airbnb in Lisbon for four people in May." | The user is choosing between places and will judge them by how they look. | One photo per listing you recommend, in the order you list them. |
| "Suggest a venue for a 60-person team offsite near Austin." | Venues are chosen by space and feel. | One photo of each shortlisted venue; skip floor plans and logos. |
| "What does a Shiba Inu look like next to an Akita?" | The user asked to see the difference. | One clear photo of each breed. |
| "Which standing desk should I buy under $500?" | Products are compared partly on appearance. | One product photo per recommended desk; skip banners and size charts. |
| "Show me the house Frank Lloyd Wright built over a waterfall." | An explicit request to see a single subject. | One photo, two at most. |

## The user asked for images

An explicit request is enough on its own, even for subjects you would otherwise answer in text.

| Request | Why | What to pick |
| --- | --- | --- |
| "Show me some photos of Shibuya Crossing at night." | A direct request. Search for the look, not the facts. | 2 to 4 night photos of the crossing. |
| "What's the latest on the Starship launch? Include photos." | News is usually text-only, but the user asked for pictures. Answer the news with sources as usual. | Photos of the launch itself; skip mission patches and article banners. |
| "Show me the current Node.js logo." | The user wants a logo, so a logo is the right image. | The official logo, one image. |
| "Find me three hotels near Gion, with pictures." | Pictures were requested for a set of options. | One photo per hotel you recommend. |
| "Can I see the second one?" after a list of venues | A follow-up about an earlier result. | Search again with `includeImages: true` for that venue and show 1 to 3 photos of it. |
| "Show me 5 pictures of Fallingwater." | A requested count, within the limit of 6. | Five distinct photos; fewer only if the search did not return five good ones. |

Still skip images, even when asked, when:

| Request | What to do instead |
| --- | --- |
| "Show me photos of the venue" arriving from Telegram | Answer in text and say pictures only appear in the desktop chat. |
| "Find Lisbon Airbnbs with photos and put them in a spreadsheet" | Build the file as asked; the collage does not go into files. |
| "Show me what shingles looks like." | Describe it and link an authoritative medical source. |
| "Make me a picture of a castle at sunset." | Image generation, not web search. This skill does not apply. |

## Do not show images

| Request | Why |
| --- | --- |
| "What is the current refund policy for Airbnb long stays?" | A policy question. The topic overlaps with travel, but the answer is text. |
| "What were Apple's quarterly earnings?" | Figures and news, and no pictures were asked for. A logo or a chart screenshot adds nothing. |
| "How do I configure CORS in Express?" | Technical how-to. |
| "Is the Louvre open on Tuesdays?" | A quick fact, even though the subject is photogenic. |
| "Find three Lisbon Airbnbs and save them to a spreadsheet." | The result is a file. The collage only exists in chat. |
| "Find a venue for the offsite" arriving from Telegram. | The user is reading on Telegram, where the collage is not shown. |
| "What does shingles look like?" | Medical imagery. Describe it and link to an authoritative source instead. |
| "Find me a plumber near Leeds." | A service chosen on reviews and price; search photos are logos and stock images. |

## Borderline

- "Best restaurants in Kyoto for a birthday dinner": show images if the search returned real photos of the specific restaurants you recommend. If it returned generic food pictures or logos, answer without them.
- "Tell me about the Golden Gate Bridge": the user asked for information. One photo is reasonable; a collage is not.
- "Compare the iPhone and Pixel cameras": the answer is about specifications and sample quality. Skip images unless the user asks to see the phones.
- The search returned four photos but three are from the same listing: show one from that listing and one from each other option you mention, or just the one if nothing else fits.
