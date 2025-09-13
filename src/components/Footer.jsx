import React from 'react';

export default function Footer() {
  return (
    <footer>
      <div className="container">
        &copy; {new Date().getFullYear()} ACS Chennai / VirtualOffice. All rights reserved.
      </div>
    </footer>
  );
}