import React from "react";
import logo from "/logo.svg";

export default function Navbar() {
  return (
    <nav className="flex justify-between items-center px-8 py-4 bg-acsdark fixed w-full z-50 shadow-lg">
      <div className="flex items-center gap-3">
        <img src={logo} alt="ACS Chennai Logo" className="w-10 h-10" />
        <span className="text-2xl font-bold tracking-wide">ACS Chennai</span>
      </div>
      <ul className="flex gap-6 text-lg font-medium">
        <li><a href="#about" className="hover:text-acsblue">About</a></li>
        <li><a href="#services" className="hover:text-acsblue">Services</a></li>
        <li><a href="#projects" className="hover:text-acsblue">Projects</a></li>
        <li><a href="#contact" className="hover:text-acsblue">Contact</a></li>
      </ul>
    </nav>
  );
}