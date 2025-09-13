import React from "react";

export default function Hero() {
  return (
    <section className="relative h-screen flex items-center justify-center text-white bg-gradient-to-br from-blue-900 via-gray-900 to-gray-800">
      <video
        autoPlay
        loop
        muted
        className="absolute w-full h-full object-cover opacity-50"
        src="https://www.pexels.com/video/855288/ACSChennai.mp4" // Use your own or copyright-free video URL
      />
      <div className="relative z-10 text-center p-8 backdrop-blur-md bg-black/30 rounded-lg shadow-lg">
        <h1 className="text-5xl font-extrabold mb-4 drop-shadow-lg">ACS Chennai</h1>
        <p className="text-xl mb-8">Precision. Management. Commitment.<br/>Leaders in PMC Civil Works</p>
        <a href="#contact" className="inline-block px-8 py-3 bg-blue-600 hover:bg-blue-800 text-white rounded-lg font-bold shadow-lg transition">Get in Touch</a>
      </div>
    </section>
  );
}