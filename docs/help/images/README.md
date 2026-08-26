# Pictures in the help centre

Two kinds live here, and they are refreshed differently.

## Diagrams

Authored SVG, edited like code. `resolver.svg` is the only one so far, explaining the
concept merchants reliably get wrong — that campaigns do not stack.

They carry their own `<title>` and `<desc>`, and the markdown gives them alt text that
describes what they show rather than the word "diagram". A test asserts that.

## Screenshots

**Cropped to the app frame, never the whole window.** A full-window capture of the
development store carries the shop's name in the topbar, the account chip, and a sidebar
listing every other app installed — which on this store includes three direct competitors.
None of that belongs in a published help centre.

The crop that removes all of it, for a 1568×750 capture:

```shell
sips -s format png --cropOffset 60 250 -c <height> 1318 capture.jpg --out docs/help/images/name.png
```

`60` clears the admin topbar, `250` clears the sidebar, and the height is chosen to end
just below the content — which also removes the "dev previews" badge the CLI paints in the
bottom-right corner while `npm run dev` is running.

**Check the crop before committing.** The topbar and sidebar are the obvious leaks; the
less obvious one is a page that shows the shop's own domain inside the app frame. The
dashboard's Store card does exactly that, which is why there is no dashboard screenshot
here.

### Keeping them current

There is no test for this and there cannot really be one: a screenshot of last month's UI
is still a valid PNG. What there is instead:

- a test asserting every image a page references is one the help centre will serve, so a
  renamed file fails rather than 404ing quietly, and
- the rule that a PR changing a page a screenshot shows should recapture it.

Recapturing is the sequence above against a running `npm run dev`, which takes a couple of
minutes. Doing it as part of the UI change is much cheaper than a sweep later.
