// The source of the icons in web/public: apple-touch-icon.png (180, edge to edge: the system rounds it),
// icon-192.png and icon-512.png (the rounded tile of mark.svg), and the 16 and 32 pixel PNGs inside
// favicon.ico. They are not built: to make them again, run this in a Chromium page's console (about:blank
// will do). It returns the PNGs as data URLs; favicon.ico is an ICO directory holding the two small PNGs.
(async () => {
  const glyph = `<g stroke="#bcc46a" stroke-width="2" stroke-linecap="round"><circle cx="13.5" cy="13.5" r="7.5"/><path d="M13.5 6v4.2M7 17.25l3.64-2.1M20 17.25l-3.64-2.1"/><path d="M21 13.5V25"/></g><circle cx="13.5" cy="13.5" r="1.6" fill="#bcc46a"/><rect x="19" y="24" width="4" height="4" rx="1" fill="#bcc46a"/>`;
  const tile = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#15161a"/>${glyph}</svg>`;
  const bleed = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-5 -5 42 42"><rect x="-5" y="-5" width="42" height="42" fill="#15161a"/>${glyph}</svg>`;
  const draw = (svg, size) => new Promise((done) => {
    const image = new Image();
    image.onload = () => { const c = document.createElement("canvas"); c.width = c.height = size; c.getContext("2d").drawImage(image, 0, 0, size, size); done(c.toDataURL("image/png")); };
    image.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
  });
  return JSON.stringify({ "apple-touch-icon": await draw(bleed, 180), "icon-192": await draw(tile, 192), "icon-512": await draw(tile, 512), "fav-32": await draw(tile, 32), "fav-16": await draw(tile, 16) });
})()
