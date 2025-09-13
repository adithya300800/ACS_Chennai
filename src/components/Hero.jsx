import React from "react";
import { motion } from "framer-motion";

export default function Hero() {
  return (
    <section id="hero" className="relative min-h-screen flex items-center justify-center bg-acsdark">
      <video
        autoPlay
        loop
        muted
        playsInline
        className="absolute inset-0 w-full h-full object-cover opacity-40"
        src="/videos/hero.mp4"
        poster="/images/hero.jpg"
      />
      <div className="relative z-10 flex flex-col items-center text-center p-8">
        <motion.h1
          className="text-5xl md:text-7xl font-extrabold mb-6 drop-shadow-xl"
          initial={{ opacity: 0, y: 30 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 1 }}
        >
          Building Landmarks, <br /> Managing Excellence
        </motion.h1>
        <motion.p
          className="text-2xl md:text-3xl mb-8 max-w-xl mx-auto text-white/90"
          initial={{ opacity: 0, y: 30 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 1, delay: 0.4 }}
        >
          ACS Chennai – Premier Project Management Consultancy for Civil Engineering Works
        </motion.p>
        <a href="#contact" className="inline-block px-8 py-3 bg-acsblue hover:bg-blue-800 text-white rounded-lg font-bold shadow-lg transition">
          Request Consultation
        </a>
      </div>
    </section>
  );
}