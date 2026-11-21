import { Command } from "commander";

const program = new Command();

program
  .name("vika")
  .description("Find error patterns that first appeared after a deploy and name the suspect commit/PR.")
  .version("0.0.0");

program.parse();
