export function wrapInHtml(text: string): string {
  const paragraphs = text.split("\n\n");

  return paragraphs
    .map((chunk) => {
      return `<p>${chunk}</p>`;
    })
    .join("\n");
}
