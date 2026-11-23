package com.example.shop.api;

import com.example.shop.api.dto.CustomerDto;
import com.example.shop.domain.repo.CustomerRepository;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Controller;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestMethod;
import org.springframework.web.bind.annotation.ResponseBody;

@Controller
@RequestMapping(path = ApiPaths.CUSTOMERS)
public class CustomerController {
  @Autowired
  private CustomerRepository customers;

  @RequestMapping(value = "/{id}", method = RequestMethod.GET)
  @ResponseBody
  public CustomerDto get(@PathVariable Long id) {
    return customers.findById(id).map(c -> new CustomerDto(c.getId(), c.getName(), c.getEmail())).orElseThrow();
  }
}
