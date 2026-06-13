import "./styles.css";

export const metadata = {
  title: "Accom Checker",
  description: "Status dashboard for the LSE accommodation checker.",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
