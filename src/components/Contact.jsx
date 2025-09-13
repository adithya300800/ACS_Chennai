import React from "react";

export default function Contact() {
  return (
    <section id="contact" className="py-24 px-4 md:px-16 bg-blue-50 text-acsdark">
      <div className="max-w-3xl mx-auto text-center">
        <h2 className="text-4xl font-bold mb-8">Contact Us</h2>
        <p className="mb-8">Ready to discuss your project or need expert PMC support? Send us a message!</p>
        <form className="flex flex-col gap-6 items-center">
          <input type="text" placeholder="Your Name" className="w-full max-w-md p-3 rounded-lg border border-blue-300"/>
          <input type="email" placeholder="Your Email" className="w-full max-w-md p-3 rounded-lg border border-blue-300"/>
          <textarea placeholder="Message" className="w-full max-w-md p-3 rounded-lg border border-blue-300 h-32"/>
          <button className="bg-acsblue text-white px-8 py-3 rounded-lg font-bold shadow-lg hover:bg-blue-800">Send</button>
        </form>
        <div className="mt-8 text-base">
          <b>Email:</b> info@acschennai.com<br/>
          <b>Phone:</b> +91 98765 43210<br/>
          <b>Location:</b> Chennai, India
        </div>
      </div>
    </section>
  );
}