<<<<<<< HEAD
import fs from "fs";
import csv from "csvtojson";

csv()
  .fromFile("customers.csv")  // your Stripe export file
  .then((jsonObj) => {
    fs.writeFileSync("customers.json", JSON.stringify(jsonObj, null, 2));
    console.log("✅ customers.json created successfully!");
  });
=======
import fs from "fs";
import csv from "csvtojson";

csv()
  .fromFile("customers.csv")  // your Stripe export file
  .then((jsonObj) => {
    fs.writeFileSync("customers.json", JSON.stringify(jsonObj, null, 2));
    console.log("✅ customers.json created successfully!");
  });
>>>>>>> 503238c (Initial commit for Render backend)
