// Type declarations for Prism syntax highlighter
interface PrismStatic {
  highlightAll: () => void;
  highlightElement: (element: HTMLElement) => void;
  highlight: (text: string, grammar: any, language: string) => string;
}

interface Window {
  Prism: PrismStatic;
}