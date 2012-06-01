export PATH=$PWD/build/node/bin:$PWD/node_modules/.bin:$PATH

alias server='node main.js -p 1053 -d 2>&1 | bunyan'
alias test='nodeunit test/*.test.js 2>&1 | bunyan'
