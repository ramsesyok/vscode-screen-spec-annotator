document.addEventListener("click", event => {
  const link = event.target.closest?.('a[href^="#"]');
  if (!link) return;

  const heading = document.getElementById(decodeURIComponent(link.hash.slice(1)));
  if (!heading) return;

  event.preventDefault();
  heading.tabIndex = -1;
  heading.focus({ preventScroll: true });
  heading.scrollIntoView({ block: "start" });
}, true);
